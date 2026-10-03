import { cacheCatalogRead } from "@/lib/catalog-cache";
import { getApprovedSubmissionRatTally, getMergedSightingsByMovie, rodentTypesFromMerged } from "@/lib/moderation-store";
import { getCatalogListMovies, getCatalogStatsWithCommunity } from "@/lib/movie-catalog";
import { estimateRatsForAppearance, type Movie } from "@/lib/whererat";

/** Everything the catalog list needs to know about a movie's sightings, without the sightings. */
export type MovieSightingMetrics = {
  sightingCount: number;
  /** Latest approval time across the movie's sightings (epoch ms), 0 when none. */
  latestSightingMs: number;
  ratsLogged: number;
  /** True when any sighting belongs to a series (drives the "N seasons · M episodes" line). */
  isSeries: boolean;
};

export const EMPTY_SIGHTING_METRICS: MovieSightingMetrics = {
  sightingCount: 0,
  latestSightingMs: 0,
  ratsLogged: 0,
  isSeries: false,
};

export type SightingIndex = {
  metrics: Record<string, MovieSightingMetrics>;
  /** Movie id -> rodent types with at least one visible sighting. */
  rodentTypes: Record<string, string[]>;
};

/** Per-movie sighting metrics and rodent types, from one pass over the merged sightings. */
async function buildSightingIndex(): Promise<SightingIndex> {
  const merged = await getMergedSightingsByMovie();
  const metrics: Record<string, MovieSightingMetrics> = {};
  for (const [movieId, sightings] of merged) {
    let latestSightingMs = 0;
    let ratsLogged = 0;
    let isSeries = false;
    for (const sighting of sightings) {
      const ms = sighting.submissionReviewedAtISO
        ? new Date(sighting.submissionReviewedAtISO).getTime()
        : 0;
      if (Number.isFinite(ms)) latestSightingMs = Math.max(latestSightingMs, ms);
      ratsLogged += estimateRatsForAppearance(sighting);
      if (sighting.imdbKind === "series") isSeries = true;
    }
    metrics[movieId] = { sightingCount: sightings.length, latestSightingMs, ratsLogged, isSeries };
  }
  const rodentTypes: Record<string, string[]> = {};
  for (const [movieId, types] of rodentTypesFromMerged(merged)) rodentTypes[movieId] = [...types];
  return { metrics, rodentTypes };
}

export type CatalogBrowseStats = {
  movies: number;
  sightings: number;
  spoilerSightings: number;
  /** Rats across base sightings plus approved-queue submissions. */
  ratsTallied: number;
};

async function buildBrowseStats(): Promise<CatalogBrowseStats> {
  const [stats, approvedSubmissionRats] = await Promise.all([
    getCatalogStatsWithCommunity(),
    getApprovedSubmissionRatTally(),
  ]);
  return { ...stats, ratsTallied: stats.ratsTallied + approvedSubmissionRats };
}

/**
 * Cached reads for list views (home page, `/api/v1/catalog`). Each is a single entry in
 * Next's data cache, tagged for {@link invalidateCatalogCache}; see `catalog-cache.ts`.
 */
export const getCachedCatalogListMovies: () => Promise<Movie[]> = cacheCatalogRead(
  getCatalogListMovies,
  ["list-movies"],
);
export const getCachedSightingIndex: () => Promise<SightingIndex> = cacheCatalogRead(
  buildSightingIndex,
  ["sighting-index"],
);
export const getCachedBrowseStats: () => Promise<CatalogBrowseStats> = cacheCatalogRead(
  buildBrowseStats,
  ["browse-stats"],
);

/** Movie ids that have at least one visible sighting of `rodentType`. */
export function movieIdsWithRodentType(index: SightingIndex, rodentType: string): Set<string> {
  const ids = new Set<string>();
  for (const [movieId, types] of Object.entries(index.rodentTypes)) {
    if (types.includes(rodentType)) ids.add(movieId);
  }
  return ids;
}

export type CatalogSortKey =
  | "latest-added-title"
  | "latest-sighting"
  | "most-rats-logged"
  | "total-sightings";

export type RankedMovie = MovieSightingMetrics & {
  movie: Movie;
  /** Position in catalog (creation) order — "latest added" is the highest. */
  catalogIndex: number;
};

/** Attaches metrics + catalog position to each result and sorts by `sort` (descending). */
export function rankMovies(
  results: readonly Movie[],
  catalog: readonly Movie[],
  index: SightingIndex,
  sort: CatalogSortKey,
): RankedMovie[] {
  const positionById = new Map(catalog.map((movie, position) => [movie.id, position]));
  const ranked = results.map((movie) => ({
    movie,
    ...(index.metrics[movie.id] ?? EMPTY_SIGHTING_METRICS),
    catalogIndex: positionById.get(movie.id) ?? 0,
  }));
  return ranked.sort((a, b) => {
    if (sort === "latest-sighting") {
      if (b.latestSightingMs !== a.latestSightingMs) return b.latestSightingMs - a.latestSightingMs;
      return b.catalogIndex - a.catalogIndex;
    }
    if (sort === "most-rats-logged") {
      if (b.ratsLogged !== a.ratsLogged) return b.ratsLogged - a.ratsLogged;
      return b.sightingCount - a.sightingCount;
    }
    if (sort === "total-sightings") {
      if (b.sightingCount !== a.sightingCount) return b.sightingCount - a.sightingCount;
      return b.ratsLogged - a.ratsLogged;
    }
    return b.catalogIndex - a.catalogIndex;
  });
}
