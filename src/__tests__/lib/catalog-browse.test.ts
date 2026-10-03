/**
 * catalog-browse.ts: per-movie metrics derived in one pass over the merged sightings,
 * ranking/sorting for list views, and the cached read wrappers (cache bypassed here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.WHERERAT_CATALOG_CACHE_SECONDS = "0";
});

const h = vi.hoisted(() => ({
  merged: vi.fn(),
  tally: vi.fn(),
  rodents: vi.fn(),
  list: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("@/lib/moderation-store", () => ({
  getMergedSightingsByMovie: h.merged,
  getApprovedSubmissionRatTally: h.tally,
  rodentTypesFromMerged: h.rodents,
}));
vi.mock("@/lib/movie-catalog", () => ({
  getCatalogListMovies: h.list,
  getCatalogStatsWithCommunity: h.stats,
}));

import {
  EMPTY_SIGHTING_METRICS,
  getCachedBrowseStats,
  getCachedCatalogListMovies,
  getCachedSightingIndex,
  movieIdsWithRodentType,
  rankMovies,
} from "@/lib/catalog-browse";
import type { Movie, Sighting } from "@/lib/whererat";

const sighting = (over: Partial<Sighting> = {}): Sighting =>
  ({ id: "s", movieId: "m", sceneType: "live-action", ...over }) as Sighting;

const movie = (id: string) => ({ id }) as Movie;

beforeEach(() => {
  vi.clearAllMocks();
  h.rodents.mockReturnValue(new Map());
});

describe("getCachedSightingIndex", () => {
  it("counts sightings and sums estimated rats per movie (swarm = 6, clamped counts)", async () => {
    h.merged.mockResolvedValue(
      new Map([
        [
          "m1",
          [
            sighting({ approximateRatCount: 3 }),
            sighting({ approximateRatCount: 2.9 }), // floored
            sighting({ sceneType: "swarm" }), // no count -> 6
            sighting(), // no count -> 1
            sighting({ approximateRatCount: 50_000 }), // capped at 9999
          ],
        ],
      ]),
    );
    const { metrics } = await getCachedSightingIndex();
    expect(metrics.m1).toMatchObject({ sightingCount: 5, ratsLogged: 3 + 2 + 6 + 1 + 9999 });
  });

  it("tracks the latest approval time, ignoring missing and unparseable dates", async () => {
    h.merged.mockResolvedValue(
      new Map([
        [
          "m1",
          [
            sighting({ submissionReviewedAtISO: "2024-01-01T00:00:00.000Z" }),
            sighting({ submissionReviewedAtISO: "2025-06-01T00:00:00.000Z" }),
            sighting({ submissionReviewedAtISO: "not a date" }),
            sighting(),
          ],
        ],
      ]),
    );
    const { metrics } = await getCachedSightingIndex();
    expect(metrics.m1!.latestSightingMs).toBe(Date.parse("2025-06-01T00:00:00.000Z"));
  });

  it("a movie is a series when any of its sightings is", async () => {
    h.merged.mockResolvedValue(
      new Map([
        ["a", [sighting(), sighting({ imdbKind: "series" })]],
        ["b", [sighting({ imdbKind: "movie" })]],
      ]),
    );
    const { metrics } = await getCachedSightingIndex();
    expect(metrics.a!.isSeries).toBe(true);
    expect(metrics.b!.isSeries).toBe(false);
  });

  it("serialises rodent types as arrays (the index must survive JSON in the data cache)", async () => {
    h.merged.mockResolvedValue(new Map());
    h.rodents.mockReturnValue(new Map([["m1", new Set(["rat", "mouse"])]]));
    const index = await getCachedSightingIndex();
    expect(index.rodentTypes).toEqual({ m1: ["rat", "mouse"] });
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });

  it("reads every movie's sightings with a single bulk call", async () => {
    h.merged.mockResolvedValue(new Map());
    await getCachedSightingIndex();
    expect(h.merged).toHaveBeenCalledTimes(1);
  });
});

describe("movieIdsWithRodentType", () => {
  it("returns the movies whose sightings include the type", () => {
    const index = { metrics: {}, rodentTypes: { a: ["rat"], b: ["rat", "mouse"], c: ["beaver"] } };
    expect(movieIdsWithRodentType(index, "mouse")).toEqual(new Set(["b"]));
    expect(movieIdsWithRodentType(index, "rat")).toEqual(new Set(["a", "b"]));
    expect(movieIdsWithRodentType(index, "gerbil")).toEqual(new Set());
  });
});

describe("rankMovies", () => {
  const catalog = [movie("a"), movie("b"), movie("c")];
  const index = {
    rodentTypes: {},
    metrics: {
      a: { sightingCount: 1, latestSightingMs: 300, ratsLogged: 9, isSeries: false },
      b: { sightingCount: 3, latestSightingMs: 100, ratsLogged: 3, isSeries: true },
      // c has no sightings at all
    },
  };
  const order = (sort: Parameters<typeof rankMovies>[3]) =>
    rankMovies(catalog, catalog, index, sort).map((r) => r.movie.id);

  it("latest-added-title: newest catalog entry first", () => {
    expect(order("latest-added-title")).toEqual(["c", "b", "a"]);
  });

  it("latest-sighting: most recent approval first, ties by catalog position", () => {
    expect(order("latest-sighting")).toEqual(["a", "b", "c"]);
  });

  it("most-rats-logged: most rats first", () => {
    expect(order("most-rats-logged")).toEqual(["a", "b", "c"]);
  });

  it("total-sightings: most sightings first", () => {
    expect(order("total-sightings")).toEqual(["b", "a", "c"]);
  });

  it("movies with no sightings get zeroed metrics and still rank", () => {
    const [c] = rankMovies([movie("c")], catalog, index, "total-sightings");
    expect(c).toMatchObject({ ...EMPTY_SIGHTING_METRICS, catalogIndex: 2 });
  });

  it("a movie missing from the catalog list sorts as position 0 rather than throwing", () => {
    const [ghost] = rankMovies([movie("ghost")], catalog, index, "latest-added-title");
    expect(ghost!.catalogIndex).toBe(0);
  });

  it("ties on a secondary sort key fall back to the other metric", () => {
    const tied = {
      rodentTypes: {},
      metrics: {
        a: { sightingCount: 2, latestSightingMs: 0, ratsLogged: 5, isSeries: false },
        b: { sightingCount: 1, latestSightingMs: 0, ratsLogged: 5, isSeries: false },
      },
    };
    const ids = (sort: Parameters<typeof rankMovies>[3]) =>
      rankMovies([movie("a"), movie("b")], [movie("a"), movie("b")], tied, sort).map((r) => r.movie.id);
    expect(ids("most-rats-logged")).toEqual(["a", "b"]); // same rats, more sightings wins
  });

  it("does not mutate the input results", () => {
    const results = [movie("a"), movie("b"), movie("c")];
    rankMovies(results, catalog, index, "latest-added-title");
    expect(results.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("cached reads", () => {
  it("getCachedCatalogListMovies reads the slim catalog", async () => {
    h.list.mockResolvedValue([movie("a")]);
    expect(await getCachedCatalogListMovies()).toEqual([movie("a")]);
  });

  it("getCachedBrowseStats adds approved-submission rats to the sighting tally", async () => {
    h.stats.mockResolvedValue({ movies: 4, sightings: 9, spoilerSightings: 2, ratsTallied: 30 });
    h.tally.mockResolvedValue(12);
    expect(await getCachedBrowseStats()).toEqual({
      movies: 4,
      sightings: 9,
      spoilerSightings: 2,
      ratsTallied: 42,
    });
  });
});
