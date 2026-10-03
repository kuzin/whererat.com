import { describe, it, expect, vi, beforeEach } from "vitest";

// The data cache needs a Next runtime; these tests exercise the logic behind it.
vi.hoisted(() => {
  process.env.WHERERAT_CATALOG_CACHE_SECONDS = "0";
});

vi.mock("@/lib/movie-catalog", () => ({
  getCatalogListMovies: vi.fn(),
  getCatalogStatsWithCommunity: vi.fn(),
  searchCatalogMovies: vi.fn(),
  getCatalogGenres: vi.fn(),
}));
vi.mock("@/lib/moderation-store", () => ({
  getMergedSightingsByMovie: vi.fn(),
  getApprovedSubmissionRatTally: vi.fn(),
  rodentTypesFromMerged: vi.fn(() => new Map()),
}));
vi.mock("@/lib/movie-page-visuals", () => ({
  getMoviePagePalettes: vi.fn(),
}));

import { getV1CatalogJson } from "@/lib/api-v1/catalog";
import {
  getCatalogListMovies,
  searchCatalogMovies,
  getCatalogGenres,
} from "@/lib/movie-catalog";
import { getMergedSightingsByMovie } from "@/lib/moderation-store";
import { getMoviePagePalettes } from "@/lib/movie-page-visuals";
import type { Sighting } from "@/lib/whererat";

const mockGetCatalogListMovies = vi.mocked(getCatalogListMovies);
const mockSearchCatalogMovies = vi.mocked(searchCatalogMovies);
const mockGetCatalogGenres = vi.mocked(getCatalogGenres);
const mockGetMergedSightingsByMovie = vi.mocked(getMergedSightingsByMovie);
const mockGetMoviePagePalettes = vi.mocked(getMoviePagePalettes);

/** The whole catalog's merged sightings, keyed by movie id (what one bulk read returns). */
function sightingsFor(byMovie: Record<string, Sighting[]>) {
  mockGetMergedSightingsByMovie.mockResolvedValue(new Map(Object.entries(byMovie)));
}

/** Catalog read returns `movies`, and the search finds all of them. */
function catalogOf(movies: unknown[]) {
  mockGetCatalogListMovies.mockResolvedValue(movies as never);
  mockSearchCatalogMovies.mockResolvedValue(movies as never);
}

function makeMovie(id: string, slug: string, overrides = {}) {
  return {
    id,
    slug,
    title: `Movie ${id}`,
    releaseYear: 2020,
    runtimeMinutes: 90,
    genres: ["Drama"],
    posterUrl: "",
    posterAlt: "",
    posterTone: "",
    summary: "",
    externalIds: { imdb: "tt0000001" },
    metadata: {
      rating: "PG",
      imdbRating: "7.0",
      imdbVotes: "10,000",
    },
    ...overrides,
  };
}

function makeSighting(movieId: string, opts: Record<string, unknown> = {}): Sighting {
  return {
    id: `sighting-${Math.random()}`,
    movieId,
    timestamp: "50%",
    description: "A rat.",
    prominence: "scene-stealer",
    sceneType: "live-action",
    spoiler: false,
    confidence: "verified",
    verificationState: "verified",
    verifiedBy: "mod",
    sourceIds: [],
    ...opts,
  } as Sighting;
}

const DEFAULT_PALETTES = { palette: null, paletteDark: null };

function setupDefaults() {
  mockGetCatalogGenres.mockResolvedValue(["Drama"] as never);
  mockGetMoviePagePalettes.mockResolvedValue(DEFAULT_PALETTES as never);
  sightingsFor({});
}

describe("getV1CatalogJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it("returns a valid v1 catalog shape", async () => {
    const movies = [makeMovie("m1", "movie-m1")];
    catalogOf(movies);

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "latest-added-title",
      page: 1,
      pageSize: 12,
    });

    expect(result.version).toBe(1);
    expect(Array.isArray(result.movies)).toBe(true);
    expect(typeof result.total).toBe("number");
    expect(typeof result.pageCount).toBe("number");
    expect(Array.isArray(result.genres)).toBe(true);
    expect(result.filters).toEqual({ q: "", genre: "all" });
    expect(result.sort).toBe("latest-added-title");
  });

  it("searches within the one catalog read it made (soft-deleted movies are excluded by that read)", async () => {
    const movies = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movies);

    await getV1CatalogJson({ query: "rat", genre: "Drama", sort: "latest-added-title", page: 1, pageSize: 12 });

    expect(mockSearchCatalogMovies).toHaveBeenCalledWith({
      query: "rat",
      genre: "Drama",
      movies,
    });
  });

  it("reads the catalog and every movie's sightings once, however many movies there are", async () => {
    const movies = Array.from({ length: 40 }, (_, i) => makeMovie(`m${i}`, `slug-m${i}`));
    catalogOf(movies);

    await getV1CatalogJson({ query: "", genre: "all", sort: "total-sightings", page: 1, pageSize: 12 });

    expect(mockGetCatalogListMovies).toHaveBeenCalledTimes(1);
    expect(mockGetMergedSightingsByMovie).toHaveBeenCalledTimes(1);
  });

  it("only computes palettes for the movies on the requested page", async () => {
    const movies = Array.from({ length: 30 }, (_, i) => makeMovie(`m${i}`, `slug-m${i}`));
    catalogOf(movies);

    const result = await getV1CatalogJson({ query: "", genre: "all", sort: "latest-added-title", page: 2, pageSize: 10 });

    expect(result.movies).toHaveLength(10);
    expect(mockGetMoviePagePalettes).toHaveBeenCalledTimes(10);
  });

  it("passes each movie's palettes and sighting count through to the response", async () => {
    const movies = [makeMovie("m1", "slug-m1")];
    catalogOf(movies);
    sightingsFor({ m1: [makeSighting("m1"), makeSighting("m1")] });
    const palette = { wash: "#111111", columnWash: "#222222", accent: "#333333", heroBloom: "#444444" };
    mockGetMoviePagePalettes.mockResolvedValue({ palette, paletteDark: null } as never);

    const result = await getV1CatalogJson({ query: "", genre: "all", sort: "latest-added-title", page: 1, pageSize: 12 });

    expect(result.movies[0]).toMatchObject({
      slug: "slug-m1",
      sightingCount: 2,
      pagePalette: palette,
      pagePaletteDark: null,
      rating: "PG",
      imdbRating: "7.0",
      imdbVotes: "10,000",
    });
  });

  it("paginates results correctly", async () => {
    const movies = Array.from({ length: 15 }, (_, i) => makeMovie(`m${i}`, `slug-m${i}`));
    catalogOf(movies);

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "latest-added-title",
      page: 2,
      pageSize: 10,
    });

    expect(result.movies).toHaveLength(5);
    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.total).toBe(15);
  });

  it("sorts by most-rats-logged", async () => {
    const movies = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movies);
    // m2 has more rats
    sightingsFor({
      m1: [makeSighting("m1", { approximateRatCount: 1 })],
      m2: [makeSighting("m2", { approximateRatCount: 10 })],
    });

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "most-rats-logged",
      page: 1,
      pageSize: 12,
    });

    expect(result.movies[0].slug).toBe("slug-m2");
    expect(result.movies[1].slug).toBe("slug-m1");
  });

  it("sorts by total-sightings", async () => {
    const movies = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movies);
    sightingsFor({
      m1: [makeSighting("m1")],
      m2: [makeSighting("m2"), makeSighting("m2"), makeSighting("m2")],
    });

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "total-sightings",
      page: 1,
      pageSize: 12,
    });

    expect(result.movies[0].slug).toBe("slug-m2");
  });

  it("sorts by latest-sighting", async () => {
    const movies = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movies);
    // m2 has a more recent review date
    sightingsFor({
      m1: [makeSighting("m1", { submissionReviewedAtISO: "2023-01-01T00:00:00Z" })],
      m2: [makeSighting("m2", { submissionReviewedAtISO: "2024-06-01T00:00:00Z" })],
    });

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "latest-sighting",
      page: 1,
      pageSize: 12,
    });

    expect(result.movies[0].slug).toBe("slug-m2");
  });

  it("returns empty movies list when search returns nothing", async () => {
    catalogOf([]);

    const result = await getV1CatalogJson({
      query: "nonexistent",
      genre: "all",
      sort: "latest-added-title",
      page: 1,
      pageSize: 12,
    });

    expect(result.movies).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.pageCount).toBe(1);
  });

  it("breaks most-rats-logged ties by sightingCount", async () => {
    // Both movies have the same ratsLogged — m2 has more sightings so ranks higher
    const movieList = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movieList);
    sightingsFor({
      m1: [makeSighting("m1", { approximateRatCount: 5 })],
      m2: [
        makeSighting("m2", { approximateRatCount: 5 }),
        makeSighting("m2", { approximateRatCount: 0 }),
      ],
    });

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "most-rats-logged",
      page: 1,
      pageSize: 12,
    });

    // Both have ratsLogged=5; m2 has more sightings so it wins the tiebreak
    expect(result.movies[0].slug).toBe("slug-m2");
  });

  it("breaks total-sightings ties by ratsLogged", async () => {
    // Both movies have the same sightingCount (1) — m2 has more ratsLogged so ranks higher
    const movieList = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movieList);
    sightingsFor({
      m1: [makeSighting("m1", { approximateRatCount: 2 })],
      m2: [makeSighting("m2", { approximateRatCount: 10 })],
    });

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "total-sightings",
      page: 1,
      pageSize: 12,
    });

    // Same sightingCount=1; m2 has more ratsLogged so it wins the tiebreak
    expect(result.movies[0].slug).toBe("slug-m2");
  });

  it("latest-added-title uses catalogIndex to sort multiple movies", async () => {
    // catalogIndex is derived from position in the catalogMovies array
    // m1 comes before m2 in the catalog, so m1 should rank lower (higher index = later addition)
    const movieList = [makeMovie("m1", "slug-m1"), makeMovie("m2", "slug-m2")];
    catalogOf(movieList);

    const result = await getV1CatalogJson({
      query: "",
      genre: "all",
      sort: "latest-added-title",
      page: 1,
      pageSize: 12,
    });

    // catalogIndex: m1=0, m2=1. Higher index → more recent → sorted first
    expect(result.movies[0].slug).toBe("slug-m2");
    expect(result.movies[1].slug).toBe("slug-m1");
  });
});
