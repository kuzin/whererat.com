import { getCatalogGenres, searchCatalogMovies } from "@/lib/movie-catalog";
import {
  getCachedCatalogListMovies,
  getCachedSightingIndex,
  rankMovies,
} from "@/lib/catalog-browse";
import { getMoviePagePalettes } from "@/lib/movie-page-visuals";

export const V1_CATALOG_PAGE_DEFAULT = 12;
export const V1_CATALOG_PAGE_MAX = 50;

export type V1CatalogSort =
  | "latest-added-title"
  | "latest-sighting"
  | "most-rats-logged"
  | "total-sightings";

export function parseV1CatalogSort(value: string | null | undefined): V1CatalogSort {
  if (
    value === "latest-added-title" ||
    value === "latest-sighting" ||
    value === "most-rats-logged" ||
    value === "total-sightings"
  ) {
    return value;
  }
  return "latest-added-title";
}

export function parseV1Page(value: string | null | undefined, fallback = 1): number {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export function clampV1PageSize(value: number): number {
  if (!Number.isFinite(value)) return V1_CATALOG_PAGE_DEFAULT;
  return Math.min(V1_CATALOG_PAGE_MAX, Math.max(1, Math.floor(value)));
}

export async function getV1CatalogJson(input: {
  query: string;
  genre: string;
  sort: V1CatalogSort;
  page: number;
  pageSize: number;
}) {
  const { query, genre, sort } = input;
  const pageSize = clampV1PageSize(input.pageSize);
  const currentPage = parseV1Page(String(input.page), 1);

  const [catalogMovies, sightingIndex] = await Promise.all([
    getCachedCatalogListMovies(),
    getCachedSightingIndex(),
  ]);
  // The catalog read already excludes soft-deleted movies.
  const filteredResults = await searchCatalogMovies({ query, genre, movies: catalogMovies });
  const sortedMetrics = rankMovies(filteredResults, catalogMovies, sightingIndex, sort);

  const totalResults = sortedMetrics.length;
  const pageOffset = (currentPage - 1) * pageSize;
  // Palettes are only needed for the movies on this page, not every match.
  const pagedMetrics = await Promise.all(
    sortedMetrics.slice(pageOffset, pageOffset + pageSize).map(async (item) => {
      const { palette, paletteDark } = await getMoviePagePalettes(item.movie);
      return { ...item, pagePalette: palette, pagePaletteDark: paletteDark };
    }),
  );
  const genres = await getCatalogGenres(catalogMovies);

  return {
    version: 1 as const,
    genres,
    sort,
    filters: {
      q: query,
      genre: genre || "all",
    },
    page: currentPage,
    pageSize,
    total: totalResults,
    pageCount: Math.max(1, Math.ceil(totalResults / pageSize)),
    movies: pagedMetrics.map(({ movie, pagePalette, pagePaletteDark, sightingCount }) => ({
      id: movie.id,
      slug: movie.slug,
      title: movie.title,
      releaseYear: movie.releaseYear,
      runtimeMinutes: movie.runtimeMinutes,
      genres: movie.genres,
      posterUrl: movie.posterUrl,
      posterAlt: movie.posterAlt,
      posterTone: movie.posterTone,
      pagePalette,
      pagePaletteDark,
      summary: movie.summary,
      sightingCount,
      rating: movie.metadata.rating,
      imdbRating: movie.metadata.imdbRating,
      imdbVotes: movie.metadata.imdbVotes,
    })),
  };
}
