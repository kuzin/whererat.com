/**
 * Server actions in src/app/moderation/actions.ts. Every external dependency
 * (cookies, redirect, cache, auth, stores, storage) is mocked; `redirect`
 * throws a tagged error carrying the URL, like the real one throws NEXT_REDIRECT.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    session: null as null | { id: string; name: string; username: string; email: string; role: "owner" | "moderator" },
    cookieValue: undefined as string | undefined,
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (h.cookieValue === undefined ? undefined : { name, value: h.cookieValue }),
  })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  MODERATOR_SESSION_COOKIE: "whererat_moderator",
  parseModeratorSession: vi.fn(() => h.session),
}));
// Privileged actions now verify the account behind the cookie. These tests drive the
// session through the mocked parseModeratorSession, so delegate to it (the real
// account re-check is covered in moderator-session.test.ts).
vi.mock("@/lib/moderator-session", async () => {
  const auth = await import("@/lib/auth");
  return { verifyModeratorSession: async (value: string | undefined) => auth.parseModeratorSession(value) };
});

vi.mock("@/lib/moderation-store", () => ({
  reviewSubmission: vi.fn().mockResolvedValue(undefined),
  deleteSubmissionById: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/media-storage", () => ({
  persistSightingFiles: vi.fn().mockResolvedValue([]),
  parseSightingImageGalleryForm: vi.fn().mockResolvedValue([]),
  persistImageFile: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@/lib/movie-imdb-sync", () => ({
  resyncAllCatalogMoviesFromImdb: vi.fn().mockResolvedValue({ synced: 0, errors: 0 }),
}));
vi.mock("@/lib/user-store", () => ({
  createStoredModerator: vi.fn().mockResolvedValue({ success: true }),
  updateUserByOwner: vi.fn().mockResolvedValue({ success: true }),
}));

import {
  moderateSubmission,
  removeSubmission,
  rereviewSubmission,
  resyncAllMovies,
  createModerator,
} from "@/app/moderation/actions";
import { revalidatePath } from "next/cache";
import { parseModeratorSession } from "@/lib/auth";
import { reviewSubmission, deleteSubmissionById } from "@/lib/moderation-store";
import { persistSightingFiles, parseSightingImageGalleryForm } from "@/lib/media-storage";
import { resyncAllCatalogMoviesFromImdb } from "@/lib/movie-imdb-sync";
import { createStoredModerator } from "@/lib/user-store";

const mockReview = vi.mocked(reviewSubmission);
const mockDelete = vi.mocked(deleteSubmissionById);
const mockGallery = vi.mocked(parseSightingImageGalleryForm);
const mockPersist = vi.mocked(persistSightingFiles);
const mockRevalidate = vi.mocked(revalidatePath);
const mockParse = vi.mocked(parseModeratorSession);

const MOD = { id: "mod-1", name: "Mo", username: "mo", email: "mo@x.io", role: "moderator" as const };
const OWNER = { ...MOD, id: "own-1", role: "owner" as const };

function form(entries: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

async function run(fn: (fd: FormData) => Promise<unknown>, fd: FormData) {
  try {
    await fn(fd);
    return { redirect: undefined as string | undefined };
  } catch (e) {
    if (e instanceof h.RedirectSignal) return { redirect: e.url };
    throw e;
  }
}

function reviewArg() {
  const call = mockReview.mock.calls.at(-1);
  if (!call) throw new Error("reviewSubmission not called");
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = MOD;
  h.cookieValue = "signed-cookie";
  mockReview.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication gate
// ─────────────────────────────────────────────────────────────────────────────
describe("moderation actions: no valid session", () => {
  beforeEach(() => {
    h.session = null;
  });

  const writes = () => [mockReview, mockDelete, mockGallery, mockPersist, vi.mocked(createStoredModerator), vi.mocked(resyncAllCatalogMoviesFromImdb)];

  it.each([
    ["moderateSubmission", moderateSubmission, { submissionId: "sub-1", decision: "approved" }],
    ["removeSubmission", removeSubmission, { submissionId: "sub-1" }],
    ["rereviewSubmission", rereviewSubmission, { submissionId: "sub-1" }],
    ["createModerator", createModerator, { newUsername: "x", newName: "x", newEmail: "x@x.io", newPassword: "secret1" }],
  ] as const)("%s redirects to /login and writes nothing", async (_n, fn, entries) => {
    const fd = form(entries);
    // even an attacker-supplied pile of uploads must not be persisted pre-auth
    fd.set("sightingImageListManaged", "1");
    fd.append("sightingImages", new File(["x"], "a.png", { type: "image/png" }));
    const r = await run(fn as (fd: FormData) => Promise<unknown>, fd);
    expect(r.redirect).toBe("/login?next=/moderation");
    for (const m of writes()) expect(m).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("resyncAllMovies redirects to /login and does no network sync", async () => {
    const r = await run(() => resyncAllMovies(), form());
    expect(r.redirect).toBe("/login?next=/moderation");
    expect(resyncAllCatalogMoviesFromImdb).not.toHaveBeenCalled();
  });

  it("the signed session cookie value is what gets verified", async () => {
    h.cookieValue = "forged-value";
    await run(moderateSubmission, form({ submissionId: "sub-1", decision: "approved" }));
    expect(mockParse).toHaveBeenCalledWith("forged-value");
  });

  it("a missing cookie is passed as undefined (and rejected)", async () => {
    h.cookieValue = undefined;
    const r = await run(moderateSubmission, form({ submissionId: "sub-1", decision: "approved" }));
    expect(mockParse).toHaveBeenCalledWith(undefined);
    expect(r.redirect).toBe("/login?next=/moderation");
  });
});

describe("moderation actions: role gates", () => {
  it("createModerator is owner-only", async () => {
    const r = await run(createModerator, form({ newUsername: "x", newName: "x", newEmail: "x@x.io", newPassword: "secret1" }));
    expect(r.redirect).toBe("/moderation");
    expect(createStoredModerator).not.toHaveBeenCalled();
  });

  it("resyncAllMovies is owner-only", async () => {
    const r = await run(() => resyncAllMovies(), form());
    expect(r.redirect).toBe("/moderation?toast=error");
    expect(resyncAllCatalogMoviesFromImdb).not.toHaveBeenCalled();
  });

  it("createModerator rejects short passwords and never creates the account", async () => {
    h.session = OWNER;
    const r = await run(createModerator, form({ newUsername: "x", newName: "x", newEmail: "x@x.io", newPassword: "12345" }));
    expect(r.redirect).toBe("/moderation?addUser=weak_password");
    expect(createStoredModerator).not.toHaveBeenCalled();
  });

  it("an owner-role request cannot be forged by a form field", async () => {
    // role is read from the signed session, never from the form
    const r = await run(createModerator, form({ newUsername: "x", newName: "x", newEmail: "x@x.io", newPassword: "secret1", role: "owner", newRole: "owner", sessionRole: "owner" }));
    expect(r.redirect).toBe("/moderation");
    expect(createStoredModerator).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// moderateSubmission: movie identity
// ─────────────────────────────────────────────────────────────────────────────
describe("moderateSubmission: movie identity edits", () => {
  const editForm = (extra: Record<string, string> = {}) =>
    form({
      submissionId: "sub-1",
      decision: "edited and approved",
      sightingTitle: "Rat on counter",
      timestamp: "42 %",
      description: "Remy appears.",
      approximateRatCount: "7",
      ...extra,
    });

  it.each([
    ["blank title", { movieTitle: "   " }],
    ["empty title", { movieTitle: "" }],
    ["blank IMDb id", { movieTitle: "Life", imdbId: "" }],
    ["garbage IMDb id", { movieTitle: "Life", imdbId: "nope" }],
    ["too-short IMDb id", { movieTitle: "Life", imdbId: "tt123" }],
    ["valid title, id missing digits", { movieTitle: "Life", imdbId: "tt" }],
  ])("%s redirects with toast=invalid-movie and calls reviewSubmission NEVER", async (_n, extra) => {
    const r = await run(moderateSubmission, editForm(extra));
    expect(r.redirect).toBe("/moderation?toast=invalid-movie&edit=sub-1");
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("the submission id in the invalid-movie redirect is URL-encoded", async () => {
    const r = await run(moderateSubmission, editForm({ submissionId: "sub 1&toast=pwned#x", movieTitle: "" }));
    expect(r.redirect).toBe(`/moderation?toast=invalid-movie&edit=${encodeURIComponent("sub 1&toast=pwned#x")}`);
    expect(r.redirect).not.toContain("&toast=pwned");
  });

  it("a valid identity edit is normalised and forwarded (IMDb URL -> tt id, title trimmed)", async () => {
    const r = await run(
      moderateSubmission,
      editForm({ movieTitle: "  Life  ", imdbId: "https://www.imdb.com/title/TT5442430/?ref_=x" }),
    );
    expect(r.redirect).toBe("/moderation?toast=moderation-approved");
    expect(reviewArg().edits).toMatchObject({
      movieTitle: "Life",
      imdbId: "tt5442430",
      title: "Rat on counter",
      timestamp: "42%",
      description: "Remy appears.",
      approximateRatCount: 7,
    });
  });

  it("a form WITHOUT identity fields leaves title and id out of the edits entirely", async () => {
    await run(moderateSubmission, editForm());
    const edits = reviewArg().edits as Record<string, unknown>;
    expect(edits).not.toHaveProperty("movieTitle");
    expect(edits).not.toHaveProperty("imdbId");
  });

  it("only the title field present -> only the title is edited", async () => {
    await run(moderateSubmission, editForm({ movieTitle: "Life" }));
    const edits = reviewArg().edits as Record<string, unknown>;
    expect(edits.movieTitle).toBe("Life");
    expect(edits).not.toHaveProperty("imdbId");
  });

  it("SQL-ish text is forwarded verbatim as values (never rewritten or executed here)", async () => {
    const evil = `Robert'); DROP TABLE movies;--`;
    await run(moderateSubmission, editForm({ movieTitle: evil, imdbId: "tt0000001", sightingTitle: evil, description: evil, reason: evil }));
    expect(reviewArg().edits).toMatchObject({ movieTitle: evil, title: evil, description: evil });
    expect(reviewArg().reason).toBe(evil);
  });

  it("imdbId text containing junk only contributes the extracted tt id", async () => {
    await run(moderateSubmission, editForm({ movieTitle: "Life", imdbId: "tt5442430'; DROP TABLE movies;--" }));
    expect((reviewArg().edits as { imdbId: string }).imdbId).toBe("tt5442430");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// moderateSubmission: decisions, redirects, edits
// ─────────────────────────────────────────────────────────────────────────────
describe("moderateSubmission: decisions", () => {
  it.each([
    ["approved", "/moderation?toast=moderation-approved"],
    ["rejected", "/moderation?toast=moderation-rejected"],
    ["edited", "/moderation?toast=moderation-saved"],
    ["edited and approved", "/moderation?toast=moderation-approved"],
  ])("decision %j -> redirect %s and exactly one reviewSubmission", async (decision, url) => {
    const r = await run(moderateSubmission, form({ submissionId: "sub-1", decision }));
    expect(r.redirect).toBe(url);
    expect(mockReview).toHaveBeenCalledOnce();
    expect(reviewArg()).toMatchObject({ submissionId: "sub-1", decision, moderator: MOD });
    expect(mockRevalidate).toHaveBeenCalledWith("/moderation");
  });

  it("supplies sensible default reasons", async () => {
    await run(moderateSubmission, form({ submissionId: "sub-1", decision: "rejected" }));
    expect(reviewArg().reason).toBe("Rejected from moderation queue.");
    await run(moderateSubmission, form({ submissionId: "sub-1", decision: "edited" }));
    expect(reviewArg().reason).toBe("Saved edits in moderation modal.");
    await run(moderateSubmission, form({ submissionId: "sub-1", decision: "edited and approved" }));
    expect(reviewArg().reason).toBe("Edited by moderator before approval.");
  });

  it("a plain approve/reject sends no edits (nothing is overwritten)", async () => {
    await run(moderateSubmission, form({ submissionId: "sub-1", decision: "approved" }));
    expect(reviewArg().edits).toBeUndefined();
  });

  it("a plain approve with only a curator note sends only that note", async () => {
    await run(moderateSubmission, form({ submissionId: "sub-1", decision: "approved", curatorNote: "  nice find  " }));
    expect(reviewArg().edits).toEqual({ curatorNote: "nice find" });
  });

  it.each([
    [{ submissionId: "", decision: "approved" }],
    [{ submissionId: "sub-1", decision: "" }],
    [{}],
  ])("missing id/decision %j is a silent no-op", async (entries) => {
    const r = await run(moderateSubmission, form(entries));
    expect(r.redirect).toBeUndefined();
    expect(mockReview).not.toHaveBeenCalled();
  });

  it("BUG: an unknown 'decision' value is cast and forwarded to reviewSubmission (which treats it as approved)", async () => {
    for (const decision of ["bogus", "APPROVED", "approve", "approved ", "merged duplicate", "pending"]) {
      mockReview.mockClear();
      await run(moderateSubmission, form({ submissionId: "sub-1", decision }));
      expect(mockReview, `decision ${JSON.stringify(decision)}`).not.toHaveBeenCalled();
    }
  });

  it("BUG: 'edited and approved' accepts blank title / timestamp / description (updateSightingInfo rejects these)", async () => {
    await run(
      moderateSubmission,
      form({ submissionId: "sub-1", decision: "edited and approved", sightingTitle: "  ", timestamp: "", description: "   " }),
    );
    const edits = (mockReview.mock.calls.at(-1)?.[0].edits ?? {}) as { description?: string; timestamp?: string };
    expect(edits.description === "" || edits.timestamp === "").toBe(false);
  });

  it("propagates a store failure instead of redirecting with a success toast", async () => {
    mockReview.mockRejectedValueOnce(new Error("Cannot add a catalog movie without an IMDb title ID"));
    await expect(
      moderateSubmission(form({ submissionId: "sub-1", decision: "approved" })),
    ).rejects.toThrow(/IMDb title ID/);
  });
});

describe("moderateSubmission: edit payload shaping", () => {
  const edit = (extra: Record<string, string> = {}) =>
    form({ submissionId: "sub-1", decision: "edited", sightingTitle: "T", timestamp: "10", description: "D", ...extra });

  it("season/episode only survive for series with values >= 1", async () => {
    await run(moderateSubmission, edit({ imdbKind: "series", seasonNumber: "2", episodeNumber: "5", episodeTitle: " Pilot " }));
    expect(reviewArg().edits).toMatchObject({ imdbKind: "series", seasonNumber: 2, episodeNumber: 5, episodeTitle: "Pilot" });

    await run(moderateSubmission, edit({ imdbKind: "series", seasonNumber: "0", episodeNumber: "-1" }));
    expect(reviewArg().edits).toMatchObject({ seasonNumber: undefined, episodeNumber: undefined });

    await run(moderateSubmission, edit({ imdbKind: "movie", seasonNumber: "2", episodeNumber: "5", episodeTitle: "x" }));
    expect(reviewArg().edits).toMatchObject({ imdbKind: "movie", seasonNumber: undefined, episodeNumber: undefined, episodeTitle: undefined });
  });

  it("BUG: a season number above int4 max is forwarded to the DB layer", async () => {
    await run(moderateSubmission, edit({ imdbKind: "series", seasonNumber: "99999999999", episodeNumber: "1" }));
    const edits = reviewArg().edits as { seasonNumber?: number };
    expect(edits.seasonNumber === undefined || edits.seasonNumber <= 2147483647).toBe(true);
  });

  it("rat count is clamped, timestamp normalised, spoiler only for exact 'on'", async () => {
    await run(moderateSubmission, edit({ approximateRatCount: "999999", timestamp: " 42 % ", spoiler: "on" }));
    expect(reviewArg().edits).toMatchObject({ approximateRatCount: 9999, timestamp: "42%", spoiler: true });
    await run(moderateSubmission, edit({ approximateRatCount: "-3", spoiler: "true" }));
    expect(reviewArg().edits).toMatchObject({ approximateRatCount: 1, spoiler: false });
  });

  it("otherRodentLabel is kept only with 'other' selected and truncated to 60 chars; other warning to 200", async () => {
    const fd = edit({ otherRodentLabel: "c".repeat(500), contentWarningOther: "w".repeat(500) });
    fd.append("rodentTypes", "other");
    await run(moderateSubmission, fd);
    const e = reviewArg().edits as { otherRodentLabel?: string; contentWarnings?: string[] };
    expect(e.otherRodentLabel).toHaveLength(60);
    expect(e.contentWarnings).toEqual(["w".repeat(200)]);

    const fd2 = edit({ otherRodentLabel: "stowaway" });
    fd2.append("rodentTypes", "mouse");
    await run(moderateSubmission, fd2);
    expect((reviewArg().edits as { otherRodentLabel?: string }).otherRodentLabel).toBeUndefined();
  });

  it("legacy image list is capped at 5 and mirrors the first image into imageUrl", async () => {
    const fd = edit({ imageListManaged: "1" });
    for (let i = 0; i < 9; i++) fd.append("finalImageUrl", `/uploads/sightings/${i}.png`);
    await run(moderateSubmission, fd);
    const e = reviewArg().edits as { images: Array<{ url: string }>; imageUrl?: string };
    expect(e.images).toHaveLength(5);
    expect(e.imageUrl).toBe("/uploads/sightings/0.png");
  });

  it("the gallery parser is used (not the legacy lists) when the sentinel is present", async () => {
    mockGallery.mockResolvedValueOnce([{ url: "/uploads/sightings/g.png", alt: "g" }]);
    await run(moderateSubmission, edit({ sightingImageListManaged: "1", finalImageUrl: "/ignored.png", imageListManaged: "1" }));
    expect(mockGallery).toHaveBeenCalledOnce();
    expect((reviewArg().edits as { images: unknown[] }).images).toEqual([{ url: "/uploads/sightings/g.png", alt: "g" }]);
  });

  it("existing images flagged for removal are dropped; new uploads are capped to 5 total", async () => {
    mockPersist.mockResolvedValueOnce([{ url: "/n1.png" }, { url: "/n2.png" }, { url: "/n3.png" }]);
    const fd = edit({ removeExistingImageUrl: "/old2.png" });
    for (const u of ["/old1.png", "/old2.png", "/old3.png", "/old4.png"]) fd.append("existingImageUrl", u);
    fd.append("sightingImages", new File(["x"], "n.png", { type: "image/png" }));
    await run(moderateSubmission, fd);
    const urls = (reviewArg().edits as { images: Array<{ url: string }> }).images.map((i) => i.url);
    expect(urls).toEqual(["/old1.png", "/old3.png", "/old4.png", "/n1.png", "/n2.png"]);
  });

  it("BUG (low): uploads are written to storage before the form is validated, so an invalid-movie / empty-decision submit leaves orphaned files", async () => {
    mockGallery.mockResolvedValueOnce([{ url: "/uploads/sightings/orphan.png" }]);
    await run(moderateSubmission, edit({ sightingImageListManaged: "1", movieTitle: "   " }));
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockGallery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// returnTo handling (open redirect)
// ─────────────────────────────────────────────────────────────────────────────
describe("returnTo: redirects stay on this site", () => {
  const hostile = [
    "https://evil.example",
    "https://evil.example/phish?x=1",
    "http://evil.example",
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
  ];
  const sameSite = (url: string | undefined) => !!url && /^\/(?![/\\])/.test(url);

  it.each(["/moderation", "/moderation?tab=history", "/movies/ratatouille?sort=newest"])(
    "normal relative returnTo %j is honoured with a toast",
    async (rt) => {
      const r = await run(removeSubmission, form({ submissionId: "sub-1", returnTo: rt }));
      expect(r.redirect).toBe(`${rt}${rt.includes("?") ? "&" : "?"}toast=deleted`);
      expect(mockDelete).toHaveBeenCalledWith("sub-1");
    },
  );

  for (const rt of hostile) {
    it(`BUG: removeSubmission redirects off-site for returnTo=${JSON.stringify(rt)}`, async () => {
      const r = await run(removeSubmission, form({ submissionId: "sub-1", returnTo: rt }));
      expect(sameSite(r.redirect), `redirect went to ${r.redirect}`).toBe(true);
    });

    it(`BUG: rereviewSubmission redirects off-site for returnTo=${JSON.stringify(rt)}`, async () => {
      const r = await run(rereviewSubmission, form({ submissionId: "sub-1", returnTo: rt }));
      expect(sameSite(r.redirect), `redirect went to ${r.redirect}`).toBe(true);
    });
  }

  it("empty returnTo falls back to /moderation", async () => {
    const r = await run(removeSubmission, form({ submissionId: "sub-1", returnTo: "   " }));
    expect(r.redirect).toBe("/moderation?toast=deleted");
  });

  it("removeSubmission with no id deletes nothing", async () => {
    const r = await run(removeSubmission, form({ submissionId: "  ", returnTo: "/moderation" }));
    expect(r.redirect).toBe("/moderation");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("rereviewSubmission re-queues using decision 'edited' (pending), not an approval", async () => {
    await run(rereviewSubmission, form({ submissionId: "sub-1" }));
    expect(reviewArg()).toMatchObject({ decision: "edited", submissionId: "sub-1" });
    expect(reviewArg().edits).toBeUndefined();
  });
});
