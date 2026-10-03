/**
 * getAllMergedSightings (moderation-store.ts): every live sighting across the
 * catalog with its movie, built from one catalog read. Must agree with the
 * per-movie view the public pages use.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Movie } from "@/lib/whererat";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  overrides: {} as Record<string, Record<string, unknown>>,
  deleted: new Set<string>(),
  movies: [] as unknown[],
  find: vi.fn(),
}));

vi.mock("@/lib/whererat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whererat")>();
  return { ...actual, submissions: [], reviewActions: [] };
});
vi.mock("@/lib/db", () => ({ getDbPool: () => ({ query: h.query }), withTransaction: vi.fn() }));
vi.mock("@/lib/sighting-edit-store", () => ({
  getSightingOverrides: vi.fn(async () => h.overrides),
  getDeletedSightingIds: vi.fn(async () => h.deleted),
}));
vi.mock("@/lib/movie-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/movie-catalog")>();
  return {
    matchCatalogMovieForSubmission: actual.matchCatalogMovieForSubmission,
    getCatalogMovies: vi.fn(async () => h.movies),
    findCatalogMovieForSubmission: h.find,
  };
});
vi.mock("@/lib/submitter-notify", () => ({ notifySubmitterOfDecision: vi.fn() }));
vi.mock("@/lib/community-movie-store", () => ({ ensureCommunityMovieForSubmission: vi.fn() }));

import { getAllMergedSightings, getMergedSightingsForMovie } from "@/lib/moderation-store";

type Row = Record<string, unknown>;
const state = { submissions: [] as Row[], reviews: [] as Row[], baseSightings: [] as Row[] };

function movie(id: string, title: string, imdb: string): Movie {
  return { id, slug: id, title, releaseYear: 2000, externalIds: { imdb }, metadata: {} } as unknown as Movie;
}

function subRow(id: string, over: Row = {}): Row {
  return {
    id,
    movie_title: "Ratatouille",
    movie_year: 2007,
    imdb_id: "tt0382932",
    imdb_kind: "movie",
    season_number: null,
    episode_number: null,
    episode_title: null,
    timestamp_code: "42%",
    title: `Sighting ${id}`,
    description: "Remy appears.",
    spoiler: false,
    approximate_rat_count: 3,
    status: "approved",
    submitted_by: "Alice",
    submitter_email: null,
    curator_note: null,
    duplicate_hint: null,
    movie_poster_url: null,
    images_json: null,
    content_warnings: null,
    rodent_types: null,
    other_rodent_label: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function baseRow(id: string, movieId: string): Row {
  return {
    id,
    movie_id: movieId,
    timestamp_code: "10%",
    title: "Base sighting",
    description: "d",
    prominence: "background",
    scene_type: "live-action",
    spoiler: false,
    confidence: "verified",
    verification_state: "verified",
    verified_by: "Mod",
    source_ids: [],
    curator_note: null,
    approximate_rat_count: null,
    submitter_name: null,
    submission_reviewed_at: null,
    content_warnings: null,
    rodent_types: null,
    other_rodent_label: null,
  };
}

const RAT = movie("rat", "Ratatouille", "tt0382932");
const JAWS = movie("jaws", "Jaws", "tt0073195");

beforeEach(() => {
  state.submissions = [];
  state.reviews = [];
  state.baseSightings = [];
  h.overrides = {};
  h.deleted = new Set();
  h.movies = [RAT, JAWS];
  h.find.mockReset();
  h.find.mockImplementation(async (s: { imdbId?: string; movieTitle: string }) =>
    [RAT, JAWS].find((m) => m.externalIds.imdb === s.imdbId),
  );
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (/select count\(\*\)/i.test(text)) return { rows: [{ count: "1" }] };
    if (/from\s+submissions\s+s\b/i.test(text)) return { rows: state.submissions };
    if (/from\s+review_actions/i.test(text)) return { rows: state.reviews };
    if (/from\s+sightings/i.test(text)) {
      return { rows: params?.length ? state.baseSightings.filter((r) => r.movie_id === params[0]) : state.baseSightings };
    }
    throw new Error(`unexpected sql: ${text}`);
  });
});

describe("getAllMergedSightings", () => {
  it("returns approved submissions and base rows, each paired with its movie", async () => {
    state.submissions = [
      subRow("sub-a", { images_json: [{ url: "/a.png", alt: "A", positionX: 5, positionY: 6, zoom: 2 }] }),
      subRow("sub-j", { imdb_id: "tt0073195", movie_title: "Jaws" }),
    ];
    state.baseSightings = [baseRow("base-1", "jaws")];
    const all = await getAllMergedSightings();
    expect(all.map((e) => [e.sighting.id, e.movie.id])).toEqual([
      ["base-1", "jaws"],
      ["queue-sub-a", "rat"],
      ["queue-sub-j", "jaws"],
    ]);
    expect(all[1]!.sighting.images).toEqual([{ url: "/a.png", alt: "A", positionX: 5, positionY: 6, zoom: 2 }]);
    expect(all[1]!.sighting.movieId).toBe("rat");
  });

  it("leaves out pending / rejected submissions and ones with no catalog movie", async () => {
    state.submissions = [
      subRow("sub-p", { status: "pending" }),
      subRow("sub-r", { status: "rejected" }),
      subRow("sub-x", { imdb_id: "tt9999999", movie_title: "Nowhere" }),
      subRow("sub-ok"),
    ];
    expect((await getAllMergedSightings()).map((e) => e.sighting.id)).toEqual(["queue-sub-ok"]);
  });

  it("leaves out base rows whose movie is not in the catalog, and soft-deleted sightings", async () => {
    state.baseSightings = [baseRow("base-orphan", "deleted-movie"), baseRow("base-gone", "rat"), baseRow("base-ok", "rat")];
    h.deleted = new Set(["base-gone"]);
    expect((await getAllMergedSightings()).map((e) => e.sighting.id)).toEqual(["base-ok"]);
  });

  it("applies sighting overrides, including override images", async () => {
    state.baseSightings = [baseRow("base-1", "rat")];
    h.overrides = { "base-1": { title: "Renamed", images: [{ url: "/o.png" }] } };
    const [entry] = await getAllMergedSightings();
    expect(entry!.sighting).toMatchObject({ title: "Renamed", images: [{ url: "/o.png" }] });
  });

  it("matches the per-movie view the public pages render", async () => {
    state.submissions = [subRow("sub-a"), subRow("sub-j", { imdb_id: "tt0073195", movie_title: "Jaws" })];
    state.baseSightings = [baseRow("base-1", "rat")];
    state.reviews = [
      {
        id: "r1",
        submission_id: "sub-a",
        movie_title: "Ratatouille",
        action: "approved",
        moderator_id: "m",
        moderator_name: "M",
        reviewed_at: "2026-02-01T00:00:00.000Z",
        note: "",
      },
    ];
    const all = await getAllMergedSightings();
    const forRat = await getMergedSightingsForMovie("rat");
    expect(all.filter((e) => e.movie.id === "rat").map((e) => e.sighting)).toEqual(forRat);
  });

  it("reads the catalog once, not once per submission", async () => {
    const { getCatalogMovies } = await import("@/lib/movie-catalog");
    vi.mocked(getCatalogMovies).mockClear();
    state.submissions = Array.from({ length: 10 }, (_, i) => subRow(`sub-${i}`));
    await getAllMergedSightings();
    expect(getCatalogMovies).toHaveBeenCalledTimes(1);
    expect(h.find).not.toHaveBeenCalled();
  });
});
