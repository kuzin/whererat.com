/**
 * Uses the REAL `@/lib/media-storage` (gallery parsing + persistImageFile) with
 * `@vercel/blob` and `node:fs/promises` mocked, so nothing touches disk or the
 * network. Covers:
 *   - parseSightingImageGalleryForm number clamping, >5 images, mismatched arrays
 *   - upload validation (mime, size, path traversal in file names)
 *   - what a *public* submission may smuggle into `addSubmission` via the
 *     `sightingImageListManaged` gallery payload (client-supplied URLs)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const blob = vi.hoisted(() => ({ put: vi.fn() }));
const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@vercel/blob", () => blob);
vi.mock("node:fs/promises", () => fsMocks);

vi.mock("@/lib/moderation-store", () => ({
  addSubmission: vi.fn(),
}));
vi.mock("@/lib/movie-catalog", () => ({
  findCatalogMovieForSubmission: vi.fn(),
}));
vi.mock("@/lib/moderation-notify", () => ({ notifyOwnerOfNewSubmission: vi.fn() }));
vi.mock("@/lib/submitter-notify", () => ({ notifySubmitterOfReceipt: vi.fn() }));
vi.mock("@/lib/email-preferences-store", () => ({ upsertMarketingOptIn: vi.fn() }));

import {
  parseSightingImageGalleryForm,
  persistImageFile,
  persistSightingFiles,
  SIGHTING_GALLERY_FIELD_NAMES as F,
  SIGHTING_GALLERY_SENTINEL,
} from "@/lib/media-storage";
import { executePublicSightingSubmit } from "@/lib/public-sighting-submit";
import { addSubmission } from "@/lib/moderation-store";
import { findCatalogMovieForSubmission } from "@/lib/movie-catalog";

const mockAdd = vi.mocked(addSubmission);

const MB = 1024 * 1024;
/** Leading bytes of each accepted format (uploads are verified against their declared type). */
const SIGNATURES: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};
const imageFile = (name: string, type: string, bytes = 16) => {
  const data = new Uint8Array(Math.max(bytes, 12)).fill(1);
  data.set(SIGNATURES[type] ?? [], 0);
  return new File([data.subarray(0, Math.max(bytes, SIGNATURES[type]?.length ?? 0))], name, { type });
};
const png = (name = "r.png", bytes = 16) => imageFile(name, "image/png", bytes);

let ip = 0;
const nextIp = () => `gal-${++ip}-${Math.random().toString(36).slice(2)}`;

function baseForm() {
  const fd = new FormData();
  fd.set("movieTitle", "Ratatouille");
  fd.set("imdbId", "tt0382932");
  fd.set("sightingTitle", "Rat in kitchen");
  fd.set("timestamp", "42%");
  fd.set("description", "Remy appears on the counter.");
  fd.set("submitterName", "Alice");
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  blob.put.mockReset().mockImplementation(async (pathname: string) => ({
    url: `https://abc123.public.blob.vercel-storage.com/${pathname}`,
  }));
  fsMocks.mkdir.mockReset().mockResolvedValue(undefined);
  fsMocks.writeFile.mockReset().mockResolvedValue(undefined);
  mockAdd.mockReset().mockResolvedValue({ id: "sub-1" } as never);
  vi.mocked(findCatalogMovieForSubmission).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSightingImageGalleryForm — numeric clamping
// ─────────────────────────────────────────────────────────────────────────────
describe("parseSightingImageGalleryForm: position / zoom clamping", () => {
  async function slot(x: string, y: string, zoom: string) {
    const fd = new FormData();
    fd.append(F.url, "/uploads/sightings/a.png");
    fd.append(F.positionX, x);
    fd.append(F.positionY, y);
    fd.append(F.zoom, zoom);
    const [s] = await parseSightingImageGalleryForm(fd, F);
    return s!;
  }

  it.each([
    ["-50", 0],
    ["-0.0001", 0],
    ["0", 0],
    ["33.3", 33.3],
    ["100", 100],
    ["100.0001", 100],
    ["1e9", 100],
    ["abc", 50],
    ["", 50],
    ["NaN", 50],
    ["Infinity", 50],
    ["-Infinity", 50],
    ["1e400", 50],
  ])("positionX %j -> %j", async (raw, expected) => {
    expect((await slot(raw, "50", "1")).positionX).toBe(expected);
    expect((await slot("50", raw, "1")).positionY).toBe(expected);
  });

  it.each([
    ["0", 1],
    ["-3", 1],
    ["0.99", 1],
    ["1", 1],
    ["2.5", 2.5],
    ["4", 4],
    ["4.01", 4],
    ["1e9", 4],
    ["abc", 1],
    ["", 1],
    ["NaN", 1],
    ["Infinity", 1],
  ])("zoom %j -> %j", async (raw, expected) => {
    expect((await slot("50", "50", raw)).zoom).toBe(expected);
  });

  it("missing position/zoom arrays default to centred, 1x", async () => {
    const fd = new FormData();
    fd.append(F.url, "/uploads/sightings/a.png");
    const [s] = await parseSightingImageGalleryForm(fd, F);
    expect(s).toMatchObject({ positionX: 50, positionY: 50, zoom: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSightingImageGalleryForm — counts and array alignment
// ─────────────────────────────────────────────────────────────────────────────
describe("parseSightingImageGalleryForm: slot count / mismatched arrays", () => {
  it("caps URL slots at 5", async () => {
    const fd = new FormData();
    for (let i = 0; i < 12; i++) fd.append(F.url, `/uploads/sightings/${i}.png`);
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toHaveLength(5);
    expect(out.map((s) => s.url)).toEqual([0, 1, 2, 3, 4].map((i) => `/uploads/sightings/${i}.png`));
  });

  it("caps uploaded files at 5 and does not persist the surplus", async () => {
    const fd = new FormData();
    for (let i = 0; i < 9; i++) fd.append(F.file, png(`f${i}.png`));
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toHaveLength(5);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(5);
  });

  it("honours options.maxImages", async () => {
    const fd = new FormData();
    for (let i = 0; i < 5; i++) fd.append(F.url, `/uploads/sightings/${i}.png`);
    expect(await parseSightingImageGalleryForm(fd, F, { maxImages: 2 })).toHaveLength(2);
    expect(await parseSightingImageGalleryForm(fd, F, { maxImages: 0 })).toHaveLength(0);
  });

  it("invalid uploads do not consume a slot (6th valid file still fits after 20 bad ones)", async () => {
    const fd = new FormData();
    for (let i = 0; i < 20; i++) fd.append(F.file, new File(["<svg/>"], `x${i}.svg`, { type: "image/svg+xml" }));
    fd.append(F.file, png("ok.png"));
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toHaveLength(1);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it("alt / position arrays shorter than the URL list fall back to defaults per slot", async () => {
    const fd = new FormData();
    for (let i = 0; i < 3; i++) fd.append(F.url, `/uploads/sightings/${i}.png`);
    fd.append(F.alt, "first alt");
    fd.append(F.positionX, "10");
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out[0]).toMatchObject({ alt: "first alt", positionX: 10, positionY: 50, zoom: 1 });
    expect(out[1]).toMatchObject({ alt: undefined, positionX: 50 });
    expect(out[2]).toMatchObject({ alt: undefined, positionX: 50 });
  });

  it("alt / position arrays LONGER than the URL list are ignored (no phantom slots)", async () => {
    const fd = new FormData();
    fd.append(F.url, "/uploads/sightings/0.png");
    for (let i = 0; i < 10; i++) {
      fd.append(F.alt, `alt${i}`);
      fd.append(F.positionX, "5");
    }
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toHaveLength(1);
  });

  it("fewer URLs than files: file slots win, missing URL entries do not throw", async () => {
    const fd = new FormData();
    fd.append(F.file, png("a.png"));
    fd.append(F.file, png("b.png"));
    fd.append(F.url, "");
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toHaveLength(2);
  });

  it("an empty placeholder File (browser sends one for untouched inputs) falls back to the URL at that index", async () => {
    const fd = new FormData();
    fd.append(F.file, new File([], "", { type: "application/octet-stream" }));
    fd.append(F.url, "/uploads/sightings/kept.png");
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toEqual([
      { url: "/uploads/sightings/kept.png", alt: undefined, positionX: 50, positionY: 50, zoom: 1 },
    ]);
  });

  it("when a slot has both a valid file and a URL, the uploaded file wins", async () => {
    const fd = new FormData();
    fd.append(F.file, png("new.png"));
    fd.append(F.url, "https://evil.example/old.png");
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toMatch(/^\/uploads\/sightings\/[0-9a-f-]{36}\.png$/);
  });

  it("when the uploaded file is invalid the slot is dropped (URL at that index is NOT used as a fallback)", async () => {
    const fd = new FormData();
    fd.append(F.file, new File(["x"], "evil.svg", { type: "image/svg+xml" }));
    fd.append(F.url, "/uploads/sightings/should-not-be-used.png");
    const out = await parseSightingImageGalleryForm(fd, F);
    expect(out).toEqual([]);
  });

  it("whitespace-only URL and no file yields no slot", async () => {
    const fd = new FormData();
    fd.append(F.url, "   ");
    expect(await parseSightingImageGalleryForm(fd, F)).toEqual([]);
  });

  it("empty form yields []", async () => {
    expect(await parseSightingImageGalleryForm(new FormData(), F)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// persistImageFile / persistSightingFiles
// ─────────────────────────────────────────────────────────────────────────────
describe("persistImageFile validation", () => {
  const opts = { folder: "sightings" as const, maxBytes: 8 * MB };

  it.each(["image/jpeg", "image/png", "image/webp", "image/gif"])("accepts %s", async (type) => {
    expect(await persistImageFile(imageFile("a", type), opts)).toBeTruthy();
  });

  it.each([
    "image/svg+xml",
    "text/html",
    "application/pdf",
    "application/javascript",
    "image/avif",
    "image/bmp",
    "",
    "image/png; charset=utf-8",
  ])("rejects mime %j", async (type) => {
    expect(await persistImageFile(new File(["x"], "a.png", { type }), opts)).toBeUndefined();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });

  it("rejects an empty file", async () => {
    expect(await persistImageFile(new File([], "a.png", { type: "image/png" }), opts)).toBeUndefined();
  });

  it("accepts exactly maxBytes and rejects maxBytes + 1", async () => {
    expect(await persistImageFile(png("a.png", 8 * MB), opts)).toBeTruthy();
    expect(await persistImageFile(png("b.png", 8 * MB + 1), opts)).toBeUndefined();
  });

  it("never lets the client file name influence the stored path (path traversal)", async () => {
    const url = await persistImageFile(png("../../../../etc/cron.d/evil.png"), opts);
    expect(url).toMatch(/^\/uploads\/sightings\/[0-9a-f-]{36}\.png$/);
    const [writtenPath] = fsMocks.writeFile.mock.calls[0]!;
    expect(String(writtenPath)).not.toContain("..");
    expect(String(writtenPath)).not.toContain("cron.d");
    expect(String(writtenPath)).toMatch(/public[\\/]uploads[\\/]sightings[\\/][0-9a-f-]{36}\.png$/);
  });

  it("the extension comes from the validated mime type, not the file name", async () => {
    const url = await persistImageFile(imageFile("payload.html", "image/jpeg"), opts);
    expect(url).toMatch(/\.jpg$/);
  });

  it("uses Vercel Blob (never the local disk) when a blob token is configured", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
    const url = await persistImageFile(png("a.png"), opts);
    expect(url).toMatch(/^https:\/\/abc123\.public\.blob\.vercel-storage\.com\/sightings\/[0-9a-f-]{36}\.png$/);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(blob.put).toHaveBeenCalledWith(
      expect.stringMatching(/^sightings\/[0-9a-f-]{36}\.png$/),
      expect.any(File),
      expect.objectContaining({ access: "public", contentType: "image/png" }),
    );
  });

  it("propagates storage failures instead of silently dropping the image", async () => {
    fsMocks.writeFile.mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(persistImageFile(png(), opts)).rejects.toThrow("ENOSPC");
  });

  it("a whitespace-only blob token counts as 'blob disabled'", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "   ");
    await persistImageFile(png(), opts);
    expect(blob.put).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
  });

  it("BUG (hardening): content is never sniffed - an HTML/script payload labelled image/jpeg is stored", async () => {
    const html = new File(["<html><script>alert(document.domain)</script></html>"], "x.jpg", {
      type: "image/jpeg",
    });
    expect(await persistImageFile(html, opts)).toBeUndefined();
  });
});

describe("persistSightingFiles", () => {
  it("persists at most 5 files, in order", async () => {
    const files = Array.from({ length: 8 }, (_, i) => png(`f${i}.png`));
    const out = await persistSightingFiles(files, 8 * MB);
    expect(out).toHaveLength(5);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(5);
  });

  it("alt text derived from the file name is sanitised", async () => {
    const [slot] = await persistSightingFiles([png('../<img src=x onerror=alert(1)>"rat".png')], 8 * MB);
    expect(slot!.alt).not.toMatch(/[<>"\/\\]/);
    expect(slot!.alt!.length).toBeLessThanOrEqual(96 + " (uploaded)".length);
  });

  it("a file name that sanitises to nothing gets the generic alt", async () => {
    const [slot] = await persistSightingFiles([png("<<>>")], 8 * MB);
    expect(slot!.alt).toBe("Uploaded sighting photo");
  });

  it("skips invalid files without failing the batch", async () => {
    const out = await persistSightingFiles(
      [new File(["x"], "a.svg", { type: "image/svg+xml" }), png("ok.png")],
      8 * MB,
    );
    expect(out).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public submit + real gallery parsing: client-supplied URLs
// ─────────────────────────────────────────────────────────────────────────────
describe("executePublicSightingSubmit + real gallery parsing", () => {
  function galleryForm(urls: string[]) {
    const fd = baseForm();
    fd.set(SIGHTING_GALLERY_SENTINEL, "1");
    for (const u of urls) fd.append(F.url, u);
    return fd;
  }

  function persistedImages(): Array<{ url: string }> {
    const arg = mockAdd.mock.calls.at(-1)?.[0];
    return (arg?.images ?? []) as Array<{ url: string }>;
  }

  it("a real uploaded file is persisted and attached (positive control)", async () => {
    const fd = baseForm();
    fd.set(SIGHTING_GALLERY_SENTINEL, "1");
    fd.append(F.file, png("rat.png"));
    fd.append(F.positionX, "120");
    fd.append(F.zoom, "9");
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r.ok).toBe(true);
    const arg = mockAdd.mock.calls.at(-1)![0];
    expect(arg.images).toHaveLength(1);
    expect(arg.images![0]).toMatchObject({ positionX: 100, zoom: 4 });
    expect(arg.imageUrl).toBe(arg.images![0]!.url);
    expect(arg.imageUrl).toMatch(/^\/uploads\/sightings\//);
  });

  it("files larger than the 8 MB public limit are dropped (not stored, submission still succeeds)", async () => {
    const fd = baseForm();
    fd.set(SIGHTING_GALLERY_SENTINEL, "1");
    fd.append(F.file, png("big.png", 8 * MB + 1));
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r.ok).toBe(true);
    expect(persistedImages()).toHaveLength(0);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it("gallery payload with 30 files stores at most 5", async () => {
    const fd = baseForm();
    fd.set(SIGHTING_GALLERY_SENTINEL, "1");
    for (let i = 0; i < 30; i++) fd.append(F.file, png(`f${i}.png`));
    await executePublicSightingSubmit(fd, nextIp());
    expect(persistedImages()).toHaveLength(5);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(5);
  });

  it("legacy multi-file payload stores at most 5", async () => {
    const fd = baseForm();
    for (let i = 0; i < 12; i++) fd.append("sightingImages", png(`f${i}.png`));
    await executePublicSightingSubmit(fd, nextIp());
    expect(persistedImages()).toHaveLength(5);
  });

  it("without the sentinel, gallery URL fields are ignored entirely", async () => {
    const fd = baseForm();
    fd.append(F.url, "https://evil.example/track.png");
    await executePublicSightingSubmit(fd, nextIp());
    expect(persistedImages()).toHaveLength(0);
  });

  // The public form has no "existing image" concept: a brand-new submission can
  // only legitimately carry freshly uploaded files. Any URL a stranger posts in
  // sightingImageUrl is therefore attacker-controlled and ends up in
  // submission_images.image_url, rendered to moderators (and, once approved, to
  // the public) as an <img>/<Image> source.
  const hostile = [
    "javascript:alert(document.cookie)",
    "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
    "data:text/html,<script>alert(1)</script>",
    "http://evil.example/track.png",
    "https://evil.example/track.png?moderator=1",
    "//evil.example/track.png",
    "../../etc/passwd",
    "/etc/passwd",
    "/api/v1/submissions",
    "file:///etc/passwd",
  ];
  for (const url of hostile) {
    it(`BUG: client-supplied gallery URL ${JSON.stringify(url)} is stored as a submission image`, async () => {
      const r = await executePublicSightingSubmit(galleryForm([url]), nextIp());
      if (!r.ok) return;
      expect(persistedImages().map((i) => i.url)).not.toContain(url);
      expect(mockAdd.mock.calls.at(-1)![0].imageUrl).not.toBe(url);
    });
  }
});
