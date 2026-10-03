/**
 * Route-level adversarial tests for POST /api/v1/submissions using the REAL
 * `executePublicSightingSubmit` (only its collaborators are mocked), so we can
 * see exactly what a native/API client receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/moderation-store", () => ({
  addSubmission: vi.fn(),
}));
vi.mock("@/lib/movie-catalog", () => ({
  findCatalogMovieForSubmission: vi.fn(),
}));
vi.mock("@/lib/media-storage", () => ({
  persistSightingFiles: vi.fn().mockResolvedValue([]),
  parseSightingImageGalleryForm: vi.fn().mockResolvedValue([]),
  SIGHTING_GALLERY_FIELD_NAMES: {
    file: "sightingImageFile",
    url: "sightingImageUrl",
    alt: "sightingImageAlt",
    positionX: "sightingImagePositionX",
    positionY: "sightingImagePositionY",
    zoom: "sightingImageZoom",
  },
  SIGHTING_GALLERY_SENTINEL: "sightingImageListManaged",
}));
vi.mock("@/lib/moderation-notify", () => ({ notifyOwnerOfNewSubmission: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/submitter-notify", () => ({ notifySubmitterOfReceipt: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email-preferences-store", () => ({ upsertMarketingOptIn: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "@/app/api/v1/submissions/route";
import { addSubmission } from "@/lib/moderation-store";
import { findCatalogMovieForSubmission } from "@/lib/movie-catalog";

const mockAdd = vi.mocked(addSubmission);

let n = 0;
const uniqueIp = () => `203.0.113.${(++n % 250) + 1}-${Math.random().toString(36).slice(2)}`;

function validForm() {
  const fd = new FormData();
  fd.set("movieTitle", "Ratatouille");
  fd.set("imdbId", "tt0382932");
  fd.set("sightingTitle", "Rat in kitchen");
  fd.set("timestamp", "42%");
  fd.set("description", "Remy appears on the counter.");
  fd.set("submitterName", "Alice");
  return fd;
}

function post(fd: FormData, headers: Record<string, string> = { "x-forwarded-for": uniqueIp() }) {
  return POST(
    new NextRequest("http://localhost/api/v1/submissions", {
      method: "POST",
      body: fd,
      headers,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockReset().mockResolvedValue({ id: "sub-route-1" } as never);
  vi.mocked(findCatalogMovieForSubmission).mockReset().mockResolvedValue(undefined);
});

describe("POST /api/v1/submissions (real submit logic)", () => {
  it("success keeps the mobile response contract {ok, submissionId, catalogSlug}", async () => {
    const res = await post(validForm());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submissionId: "sub-route-1", catalogSlug: null });
  });

  it("validation failures return 422 with a short code message, never echoing client input", async () => {
    const fd = validForm();
    fd.set("description", "");
    fd.set("sightingTitle", "<script>alert(1)</script>");
    const res = await post(fd);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "missing", message: "missing" });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("a non-multipart content-type that merely *mentions* multipart/form-data is a clean 400, not a 500", async () => {
    const req = new NextRequest("http://localhost/api/v1/submissions", {
      method: "POST",
      headers: {
        "content-type": "application/json; note=multipart/form-data",
        "x-forwarded-for": uniqueIp(),
      },
      body: JSON.stringify({ movieTitle: "x" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("autoApprove / status fields posted to the API are not forwarded to the store", async () => {
    const fd = validForm();
    fd.set("autoApprove", "on");
    fd.set("status", "approved");
    const res = await post(fd);
    expect(res.status).toBe(200);
    const arg = mockAdd.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.status).toBeUndefined();
    expect(JSON.stringify(arg)).not.toMatch(/autoApprove/);
  });

  it("rate limit: the 6th request from one client IP gets 429, earlier ones 200", async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(validForm(), { "x-forwarded-for": ip })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("rate limit falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(validForm(), { "x-real-ip": ip })).status);
    expect(statuses[5]).toBe(429);
  });

  it("documents current behaviour: the FIRST x-forwarded-for hop is the rate-limit key", async () => {
    // Clients can prepend arbitrary hops on proxies that append instead of overwrite.
    // (Vercel overwrites the header, so this is deployment dependent.)
    const first = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post(validForm(), { "x-forwarded-for": `${first}, 10.0.0.${i}` })).status);
    }
    expect(statuses[5]).toBe(429);
  });

  it("a failed insert yields 500 + error code 'server-error'", async () => {
    mockAdd.mockRejectedValueOnce(new Error("kaboom"));
    const res = await post(validForm());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "server-error" });
  });

  it("BUG: a 500 response body leaks the raw database / driver error text to API clients", async () => {
    mockAdd.mockRejectedValueOnce(
      new Error('connection to server at "ep-xyz-123.us-east-2.aws.neon.tech" (10.0.3.4), port 5432 failed: password authentication failed for user "whererat_owner"'),
    );
    const res = await post(validForm());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/neon\.tech|10\.0\.3\.4|whererat_owner|password authentication/i);
  });

  it("BUG: an out-of-range season number from the client becomes a 500 with driver text instead of a 4xx validation error", async () => {
    // Simulate Postgres: int4 column rejects the value at INSERT time.
    mockAdd.mockImplementationOnce(async (sub) => {
      if ((sub.seasonNumber ?? 0) > 2147483647) {
        throw new Error('value "99999999999" is out of range for type integer');
      }
      return { id: "sub-route-1" } as never;
    });
    const fd = validForm();
    fd.set("imdbKind", "series");
    fd.set("seasonNumber", "99999999999");
    fd.set("episodeNumber", "1");
    const res = await post(fd);
    // A client mistake (out-of-range number) should be a 4xx validation error, not a 500 with driver text.
    expect(res.status).toBeLessThan(500);
  });

  it("BUG: a missing movieYear is stored as 0 rather than omitted (later violates movies.release_year check)", async () => {
    const res = await post(validForm()); // no movieYear field at all (native clients may omit it)
    expect(res.status).toBe(200);
    expect(mockAdd.mock.calls[0]![0].movieYear).toBeUndefined();
  });
});
