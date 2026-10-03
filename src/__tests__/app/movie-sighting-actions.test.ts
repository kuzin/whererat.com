/**
 * updateSightingInfo / deleteSighting (+ the owner gate on deleteMovie) from
 * src/app/movies/[slug]/actions.ts. All collaborators are mocked; `redirect`
 * throws a tagged error carrying the URL.
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
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "signed" }) })),
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

vi.mock("@/lib/movie-edit-store", () => ({
  clearMovieOverride: vi.fn(),
  deleteMovieById: vi.fn(),
  updateMovieOverride: vi.fn(),
}));
vi.mock("@/lib/movie-imdb-sync", () => ({
  fetchImdbMedia: vi.fn(),
  fetchImdbRelated: vi.fn(),
}));
vi.mock("@/lib/moderation-store", () => ({ reviewSubmission: vi.fn() }));
vi.mock("@/lib/sighting-edit-store", () => ({
  deleteSightingById: vi.fn(),
  updateSightingOverride: vi.fn(),
}));
vi.mock("@/lib/movie-catalog", () => ({
  getCatalogMovieByImdbId: vi.fn(),
  getCatalogMovieBySlug: vi.fn(),
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
vi.mock("@/lib/movie-page-visuals", () => ({ getSyncedMoviePageVisuals: vi.fn() }));
vi.mock("@/lib/tmdb-banner", () => ({ getTmdbBackdropUrl: vi.fn() }));

import { updateSightingInfo, deleteSighting, deleteMovie } from "@/app/movies/[slug]/actions";
import { revalidatePath } from "next/cache";
import { reviewSubmission } from "@/lib/moderation-store";
import { deleteSightingById, updateSightingOverride } from "@/lib/sighting-edit-store";
import { deleteMovieById } from "@/lib/movie-edit-store";
import { getCatalogMovieByImdbId, getCatalogMovieBySlug } from "@/lib/movie-catalog";
import { parseSightingImageGalleryForm } from "@/lib/media-storage";

const mockReview = vi.mocked(reviewSubmission);
const mockOverride = vi.mocked(updateSightingOverride);
const mockDeleteSighting = vi.mocked(deleteSightingById);
const mockDeleteMovie = vi.mocked(deleteMovieById);
const mockBySlug = vi.mocked(getCatalogMovieBySlug);
const mockByImdb = vi.mocked(getCatalogMovieByImdbId);
const mockRevalidate = vi.mocked(revalidatePath);
const mockGallery = vi.mocked(parseSightingImageGalleryForm);

const MOD = { id: "mod-1", name: "Mo", username: "mo", email: "mo@x.io", role: "moderator" as const };
const OWNER = { ...MOD, id: "own-1", role: "owner" as const };

const movie = (slug: string, imdb: string, type: "movie" | "series" = "movie") =>
  ({
    id: `m-${slug}`,
    slug,
    title: slug,
    externalIds: { imdb },
    metadata: { syncSnapshot: { Type: type } },
  }) as never;

function sightingForm(extra: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    slug: "ratatouille",
    sightingId: "queue-sub-1",
    title: "Rat in kitchen",
    timestamp: " 42 % ",
    description: "Remy appears.",
    ...extra,
  };
  for (const [k, v] of Object.entries(base)) fd.set(k, v);
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

const reviewArg = () => {
  const c = mockReview.mock.calls.at(-1);
  if (!c) throw new Error("reviewSubmission not called");
  return c[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  h.session = MOD;
  mockReview.mockResolvedValue(undefined);
  mockBySlug.mockResolvedValue(movie("ratatouille", "tt0382932"));
  mockByImdb.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("updateSightingInfo: auth", () => {
  it("without a session redirects to /login and writes nothing", async () => {
    h.session = null;
    for (const sightingId of ["queue-sub-1", "seed-sighting-1"]) {
      const fd = sightingForm({ sightingId });
      const r = await run(updateSightingInfo, fd);
      expect(r.redirect).toBe("/login");
    }
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockOverride).not.toHaveBeenCalled();
    expect(mockGallery).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("deleteSighting without a session deletes nothing", async () => {
    h.session = null;
    for (const sightingId of ["queue-sub-1", "seed-sighting-1"]) {
      const r = await run(deleteSighting, sightingForm({ sightingId }));
      expect(r.redirect).toBe("/login");
    }
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockDeleteSighting).not.toHaveBeenCalled();
  });

  it("deleteMovie is owner-only (moderators are bounced, nothing deleted)", async () => {
    const r = await run(deleteMovie, sightingForm());
    expect(r.redirect).toBe("/login");
    expect(mockDeleteMovie).not.toHaveBeenCalled();
    h.session = null;
    expect((await run(deleteMovie, sightingForm())).redirect).toBe("/login");
    expect(mockDeleteMovie).not.toHaveBeenCalled();
  });

  it("deleteMovie works for the owner", async () => {
    h.session = OWNER;
    const r = await run(deleteMovie, sightingForm());
    expect(mockDeleteMovie).toHaveBeenCalledWith("m-ratatouille");
    expect(r.redirect).toBe("/?toast=deleted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("updateSightingInfo: required-field validation", () => {
  it.each([
    ["slug", { slug: "" }],
    ["sightingId", { sightingId: "" }],
    ["title", { title: "   " }],
    ["timestamp", { timestamp: "" }],
    ["description", { description: " \n " }],
  ])("blank %s redirects back to returnTo and writes nothing", async (_n, extra) => {
    const r = await run(updateSightingInfo, sightingForm({ ...extra, returnTo: "/movies/ratatouille?sort=newest" }));
    expect(r.redirect).toBe("/movies/ratatouille?sort=newest");
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockOverride).not.toHaveBeenCalled();
  });

  it("returnTo defaults to /movies/<slug>", async () => {
    const r = await run(updateSightingInfo, sightingForm({ title: "" }));
    expect(r.redirect).toBe("/movies/ratatouille");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("updateSightingInfo: queue- sightings go through reviewSubmission", () => {
  it("strips the queue- prefix, approves-with-edits, and forwards normalised fields", async () => {
    const r = await run(updateSightingInfo, sightingForm({ approximateRatCount: "99999", spoiler: "on" }));
    expect(mockOverride).not.toHaveBeenCalled();
    expect(reviewArg()).toMatchObject({
      submissionId: "sub-1",
      decision: "edited and approved",
      reason: "Edited from movie page.",
      moderator: MOD,
    });
    expect(reviewArg().edits).toMatchObject({
      title: "Rat in kitchen",
      timestamp: "42%",
      description: "Remy appears.",
      approximateRatCount: 9999,
      spoiler: true,
    });
    expect(r.redirect).toBe("/movies/ratatouille?toast=sighting-saved");
  });

  it("identity fields: IMDb URL / upper-case id is normalised, title trimmed", async () => {
    await run(
      updateSightingInfo,
      sightingForm({ movieTitle: "  Ratatouille ", imdbId: "https://www.imdb.com/title/TT0382932/" }),
    );
    expect(reviewArg().edits).toMatchObject({ movieTitle: "Ratatouille", imdbId: "tt0382932" });
  });

  it("a form without identity fields leaves title and imdbId out of the edits", async () => {
    await run(updateSightingInfo, sightingForm());
    const edits = reviewArg().edits as Record<string, unknown>;
    expect(edits).not.toHaveProperty("movieTitle");
    expect(edits).not.toHaveProperty("imdbId");
  });

  it.each([
    ["blank title", { movieTitle: "  " }],
    ["bad id", { movieTitle: "Life", imdbId: "garbage" }],
    ["blank id", { movieTitle: "Life", imdbId: "" }],
  ])("invalid identity (%s) redirects with toast=invalid-movie and never calls reviewSubmission", async (_n, extra) => {
    const r = await run(updateSightingInfo, sightingForm({ ...extra, returnTo: "/movies/ratatouille" }));
    expect(r.redirect).toBe("/movies/ratatouille?toast=invalid-movie");
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("invalid-movie toast is appended with & when returnTo already has a query", async () => {
    const r = await run(updateSightingInfo, sightingForm({ movieTitle: "", returnTo: "/movies/ratatouille?sort=newest&page=2" }));
    expect(r.redirect).toBe("/movies/ratatouille?sort=newest&page=2&toast=invalid-movie");
  });

  it("same-id save redirects back to returnTo with a toast", async () => {
    const r = await run(
      updateSightingInfo,
      sightingForm({ imdbId: "tt0382932", movieTitle: "Ratatouille", returnTo: "/movies/ratatouille?sort=newest" }),
    );
    expect(r.redirect).toBe("/movies/ratatouille?sort=newest&toast=sighting-saved");
    expect(mockByImdb).not.toHaveBeenCalled();
  });

  it("moving to a different IMDb id redirects to the target's /movies/<slug>", async () => {
    mockByImdb.mockResolvedValue(movie("life-2017", "tt5442430", "movie"));
    const r = await run(updateSightingInfo, sightingForm({ imdbId: "tt5442430", movieTitle: "Life" }));
    expect(mockByImdb).toHaveBeenCalledWith("tt5442430");
    expect(r.redirect).toBe("/movies/life-2017?toast=sighting-saved");
    expect(mockRevalidate).toHaveBeenCalledWith("/movies/life-2017");
  });

  it("moving to a TV series redirects to /shows/<slug>", async () => {
    mockByImdb.mockResolvedValue(movie("severance", "tt11280740", "series"));
    const r = await run(updateSightingInfo, sightingForm({ imdbId: "tt11280740", movieTitle: "Severance" }));
    expect(r.redirect).toBe("/shows/severance?toast=sighting-saved");
  });

  it("if the new title cannot be resolved the moderator is sent back to returnTo", async () => {
    mockByImdb.mockResolvedValue(undefined);
    const r = await run(updateSightingInfo, sightingForm({ imdbId: "tt9999999", movieTitle: "Nope", returnTo: "/movies/ratatouille" }));
    expect(r.redirect).toBe("/movies/ratatouille?toast=sighting-saved");
  });

  it("the move is decided AFTER reviewSubmission ran (so the move actually happened)", async () => {
    mockByImdb.mockResolvedValue(movie("life-2017", "tt5442430"));
    const order: string[] = [];
    mockReview.mockImplementationOnce(async () => {
      order.push("review");
    });
    mockByImdb.mockImplementationOnce(async () => {
      order.push("lookup");
      return movie("life-2017", "tt5442430");
    });
    await run(updateSightingInfo, sightingForm({ imdbId: "tt5442430", movieTitle: "Life" }));
    expect(order).toEqual(["review", "lookup"]);
  });

  it("images: legacy list capped at 5; first image mirrored into imageUrl", async () => {
    const fd = sightingForm({ imageListManaged: "1" });
    for (let i = 0; i < 8; i++) fd.append("finalImageUrl", `/uploads/sightings/${i}.png`);
    await run(updateSightingInfo, fd);
    const e = reviewArg().edits as { images: Array<{ url: string }>; imageUrl?: string };
    expect(e.images).toHaveLength(5);
    expect(e.imageUrl).toBe("/uploads/sightings/0.png");
  });

  it("SQL-ish strings are only ever passed through as values", async () => {
    const evil = `x'); DROP TABLE sightings;--`;
    await run(updateSightingInfo, sightingForm({ title: evil, description: evil, curatorNote: evil, movieTitle: evil, imdbId: "tt0382932" }));
    expect(reviewArg().edits).toMatchObject({ title: evil, description: evil, curatorNote: evil, movieTitle: evil });
  });

  it("a store failure propagates (no success toast)", async () => {
    mockReview.mockRejectedValueOnce(new Error("boom"));
    await expect(updateSightingInfo(sightingForm())).rejects.toThrow("boom");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("updateSightingInfo: non-queue sightings use sighting overrides", () => {
  const seed = (extra: Record<string, string> = {}) => sightingForm({ sightingId: "seed-sighting-1", ...extra });

  it("calls updateSightingOverride and NOT reviewSubmission", async () => {
    const r = await run(updateSightingInfo, seed());
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockOverride).toHaveBeenCalledWith(
      "seed-sighting-1",
      expect.objectContaining({ title: "Rat in kitchen", timestamp: "42%", description: "Remy appears." }),
    );
    expect(r.redirect).toBe("/movies/ratatouille?toast=sighting-saved");
  });

  it("ignores movieTitle / imdbId completely (no identity change, no invalid-movie toast, no move)", async () => {
    const r = await run(updateSightingInfo, seed({ movieTitle: "   ", imdbId: "garbage", returnTo: "/movies/ratatouille" }));
    expect(r.redirect).toBe("/movies/ratatouille?toast=sighting-saved");
    const payload = mockOverride.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("movieTitle");
    expect(payload).not.toHaveProperty("imdbId");
    expect(mockByImdb).not.toHaveBeenCalled();
  });

  it("an id that merely CONTAINS 'queue-' (or differs in case) is not treated as a queue row", async () => {
    for (const id of ["x-queue-1", "QUEUE-abc", " queue-1".trim().toUpperCase()]) {
      mockReview.mockClear();
      mockOverride.mockClear();
      await run(updateSightingInfo, seed({ sightingId: id }));
      expect(mockReview, id).not.toHaveBeenCalled();
      expect(mockOverride, id).toHaveBeenCalledOnce();
    }
  });

  it("empty rodentTypes / warnings become undefined (clears the override rather than storing [])", async () => {
    await run(updateSightingInfo, seed());
    const payload = mockOverride.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.rodentTypes).toBeUndefined();
    expect(payload.contentWarnings).toBeUndefined();
    expect(payload.otherRodentLabel).toBeUndefined();
  });

  it("clamps a hostile rat count", async () => {
    await run(updateSightingInfo, seed({ approximateRatCount: "-99" }));
    expect((mockOverride.mock.calls[0]![1] as { approximateRatCount: number }).approximateRatCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("deleteSighting", () => {
  it("queue- rows are rejected via reviewSubmission (stays auditable), not hard-deleted", async () => {
    const r = await run(deleteSighting, sightingForm({ returnTo: "/movies/ratatouille" }));
    expect(reviewArg()).toMatchObject({ submissionId: "sub-1", decision: "rejected", reason: "Removed from movie page." });
    expect(mockDeleteSighting).not.toHaveBeenCalled();
    expect(r.redirect).toBe("/movies/ratatouille?toast=deleted");
  });

  it("other ids are soft-deleted through deleteSightingById", async () => {
    const r = await run(deleteSighting, sightingForm({ sightingId: "seed-1", returnTo: "/movies/ratatouille?sort=newest" }));
    expect(mockDeleteSighting).toHaveBeenCalledWith("seed-1");
    expect(mockReview).not.toHaveBeenCalled();
    expect(r.redirect).toBe("/movies/ratatouille?sort=newest&toast=deleted");
  });

  it.each<Record<string, string>>([{ slug: "" }, { sightingId: "" }, { sightingId: "   " }])(
    "missing %j deletes nothing and returns to returnTo",
    async (extra) => {
      const r = await run(deleteSighting, sightingForm({ ...extra, returnTo: "/movies/ratatouille" }));
      expect(r.redirect).toBe("/movies/ratatouille");
      expect(mockReview).not.toHaveBeenCalled();
      expect(mockDeleteSighting).not.toHaveBeenCalled();
    },
  );

  it("SQL-ish sighting ids are only passed as values", async () => {
    const evil = "1'; DROP TABLE sightings;--";
    await run(deleteSighting, sightingForm({ sightingId: evil }));
    expect(mockDeleteSighting).toHaveBeenCalledWith(evil);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("returnTo: redirects stay on this site", () => {
  const hostile = [
    "https://evil.example",
    "https://evil.example/phish?x=1",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
  ];
  const sameSite = (url: string | undefined) => !!url && /^\/(?![/\\])/.test(url);

  for (const rt of hostile) {
    it(`BUG: updateSightingInfo (queue) redirects off-site for returnTo=${JSON.stringify(rt)}`, async () => {
      const r = await run(updateSightingInfo, sightingForm({ returnTo: rt }));
      expect(sameSite(r.redirect), `redirect went to ${r.redirect}`).toBe(true);
    });

    it(`BUG: updateSightingInfo (override) redirects off-site for returnTo=${JSON.stringify(rt)}`, async () => {
      const r = await run(updateSightingInfo, sightingForm({ sightingId: "seed-1", returnTo: rt }));
      expect(sameSite(r.redirect), `redirect went to ${r.redirect}`).toBe(true);
    });

    it(`BUG: updateSightingInfo validation-failure redirects off-site for returnTo=${JSON.stringify(rt)}`, async () => {
      const r = await run(updateSightingInfo, sightingForm({ title: "", returnTo: rt }));
      expect(sameSite(r.redirect), `redirect went to ${r.redirect}`).toBe(true);
    });

    it(`BUG: deleteSighting redirects off-site for returnTo=${JSON.stringify(rt)}`, async () => {
      const r = await run(deleteSighting, sightingForm({ returnTo: rt }));
      expect(sameSite(r.redirect), `redirect went to ${r.redirect}`).toBe(true);
    });
  }

  it("BUG: revalidatePath is called with an attacker-supplied absolute URL", async () => {
    await run(updateSightingInfo, sightingForm({ returnTo: "https://evil.example/x?y=1" }));
    for (const [p] of mockRevalidate.mock.calls) expect(String(p).startsWith("/")).toBe(true);
  });

  it("a moved sighting ignores returnTo entirely (target comes from the DB, not the form)", async () => {
    mockByImdb.mockResolvedValue(movie("life-2017", "tt5442430"));
    const r = await run(updateSightingInfo, sightingForm({ imdbId: "tt5442430", movieTitle: "Life", returnTo: "https://evil.example" }));
    expect(r.redirect).toBe("/movies/life-2017?toast=sighting-saved");
  });
});
