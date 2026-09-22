import { normalizeImdbId, RODENT_TYPE_OPTIONS, type Movie } from "@/lib/whererat";

function hasValidImdbId(imdbId: string | null | undefined): boolean {
  return Boolean(normalizeImdbId(String(imdbId ?? "")));
}
import { getDbPool } from "@/lib/db";

const FALLBACK_POSTER = "https://placehold.co/600x900/292524/fef3c7/png?text=Community+Movie";
const FALLBACK_BACKDROP =
  "https://placehold.co/1200x600/292524/fef3c7/png?text=Community+Movie";

type MovieRow = {
  id: string;
  slug: string;
  title: string;
  release_year: number;
  runtime_minutes: number;
  genres: string[];
  poster_tone: string;
  poster_url: string;
  backdrop_url: string;
  poster_alt: string;
  imdb_id: string;
  tmdb_id: string | null;
  summary: string;
  metadata: Movie["metadata"];
};

function normalizeImageUrl(value: string | undefined, fallback: string) {
  const raw = value?.trim() ?? "";
  if (!raw) return fallback;
  if (raw.startsWith("/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return fallback;
}

export async function getCatalogMovies(): Promise<Movie[]> {
  const pool = getDbPool();
  const result = await pool.query<MovieRow>(
    `select id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, summary, metadata
     from movies
     where is_deleted = false
     order by created_at asc`,
  );
  return result.rows
    .filter((row) => hasValidImdbId(row.imdb_id))
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      releaseYear: row.release_year,
      runtimeMinutes: row.runtime_minutes,
      genres: row.genres,
      posterTone: row.poster_tone,
      posterUrl: normalizeImageUrl(row.poster_url, FALLBACK_POSTER),
      backdropUrl: normalizeImageUrl(row.backdrop_url, FALLBACK_BACKDROP),
      posterAlt: row.poster_alt,
      externalIds: {
        imdb: normalizeImdbId(row.imdb_id),
        tmdb: row.tmdb_id ?? undefined,
      },
      summary: row.summary,
      metadata: row.metadata,
    }))
    .map((movie) => ({
      ...movie,
      posterUrl: normalizeImageUrl(movie.posterUrl, FALLBACK_POSTER),
      backdropUrl: normalizeImageUrl(movie.backdropUrl, FALLBACK_BACKDROP),
    }));
}

export async function getCatalogMovieBySlug(slug: string) {
  const allMovies = await getCatalogMovies();
  return allMovies.find((movie) => movie.slug === slug);
}

export async function getCatalogMovieByImdbId(imdbIdOrUrl: string) {
  const imdbId = normalizeImdbId(imdbIdOrUrl);
  if (!imdbId) return undefined;
  const allMovies = await getCatalogMovies();
  return allMovies.find((movie) => movie.externalIds.imdb === imdbId);
}

export async function getCatalogMovieByTitleSearch(title: string) {
  const results = await searchCatalogMovies({ query: title });
  return results[0];
}

// SQL for catalog search with pg_trgm fuzzy matching + sighting content
const SQL_SEARCH_WITH_TRGM = `
  SELECT m.id,
    GREATEST(
      COALESCE(ts_rank(to_tsvector('english', m.title), plainto_tsquery('english', $1)) * 3.0, 0.0),
      COALESCE(ts_rank(to_tsvector('english', m.title || ' ' || m.summary), plainto_tsquery('english', $1)), 0.0),
      CASE WHEN m.title % $1 THEN similarity(m.title, $1) * 2.0 ELSE 0.0 END,
      COALESCE((
        SELECT MAX(ts_rank(
          to_tsvector('english', coalesce(s.title, '') || ' ' || s.description),
          plainto_tsquery('english', $1)
        ))
        FROM sightings s
        WHERE s.movie_id = m.id AND s.is_deleted = false
          AND to_tsvector('english', coalesce(s.title, '') || ' ' || s.description)
              @@ plainto_tsquery('english', $1)
      ), 0.0)
    ) AS rank
  FROM movies m
  WHERE m.is_deleted = false
    AND (
      to_tsvector('english', m.title || ' ' || m.summary) @@ plainto_tsquery('english', $1)
      OR m.title % $1
      OR m.imdb_id ilike $1
      OR EXISTS (
        SELECT 1 FROM sightings s
        WHERE s.movie_id = m.id AND s.is_deleted = false
          AND to_tsvector('english', coalesce(s.title, '') || ' ' || s.description)
              @@ plainto_tsquery('english', $1)
      )
    )`;

// Fallback SQL without pg_trgm (FTS + IMDb ID only)
const SQL_SEARCH_NO_TRGM = `
  SELECT m.id,
    GREATEST(
      COALESCE(ts_rank(to_tsvector('english', m.title), plainto_tsquery('english', $1)) * 3.0, 0.0),
      COALESCE(ts_rank(to_tsvector('english', m.title || ' ' || m.summary), plainto_tsquery('english', $1)), 0.0),
      COALESCE((
        SELECT MAX(ts_rank(
          to_tsvector('english', coalesce(s.title, '') || ' ' || s.description),
          plainto_tsquery('english', $1)
        ))
        FROM sightings s
        WHERE s.movie_id = m.id AND s.is_deleted = false
          AND to_tsvector('english', coalesce(s.title, '') || ' ' || s.description)
              @@ plainto_tsquery('english', $1)
      ), 0.0)
    ) AS rank
  FROM movies m
  WHERE m.is_deleted = false
    AND (
      to_tsvector('english', m.title || ' ' || m.summary) @@ plainto_tsquery('english', $1)
      OR m.imdb_id ilike $1
      OR EXISTS (
        SELECT 1 FROM sightings s
        WHERE s.movie_id = m.id AND s.is_deleted = false
          AND to_tsvector('english', coalesce(s.title, '') || ' ' || s.description)
              @@ plainto_tsquery('english', $1)
      )
    )`;

export async function searchCatalogMovies({
  query,
  genre,
  rodentMovieIds,
}: {
  query?: string;
  genre?: string;
  /**
   * Movie ids matching the active rodent-type filter, or undefined for no filter.
   * Resolved by the caller via `getMovieIdsWithRodentType` — visible sightings are
   * merged from approved submissions, which lives in moderation-store and would be
   * a circular import here.
   */
  rodentMovieIds?: Set<string>;
}): Promise<Movie[]> {
  const allMovies = await getCatalogMovies();
  const normalizedQuery = query?.trim();

  // Apply genre filter on overridden movie data
  const genreFiltered =
    !genre || genre === "all" ? allMovies : allMovies.filter((m) => m.genres.includes(genre));

  const rodentFiltered = rodentMovieIds
    ? genreFiltered.filter((m) => rodentMovieIds.has(m.id))
    : genreFiltered;

  if (!normalizedQuery) return rodentFiltered;

  // Fast path: IMDb ID lookup
  if (/^tt\d+$/i.test(normalizedQuery)) {
    return rodentFiltered.filter(
      (m) => m.externalIds.imdb.toLowerCase() === normalizedQuery.toLowerCase(),
    );
  }

  const pool = getDbPool();
  let rows: Array<{ id: string; rank: number }>;

  try {
    const result = await pool.query<{ id: string; rank: number }>(SQL_SEARCH_WITH_TRGM, [
      normalizedQuery,
    ]);
    rows = result.rows;
  } catch {
    // pg_trgm not installed — fall back to FTS-only
    try {
      const result = await pool.query<{ id: string; rank: number }>(SQL_SEARCH_NO_TRGM, [
        normalizedQuery,
      ]);
      rows = result.rows;
    } catch {
      // SQL search unavailable — fall back to in-memory substring match
      return rodentFiltered.filter(
        (m) =>
          m.title.toLowerCase().includes(normalizedQuery.toLowerCase()) ||
          m.summary.toLowerCase().includes(normalizedQuery.toLowerCase()),
      );
    }
  }

  const rankByMovieId = new Map(rows.map((r) => [r.id, Number(r.rank)]));

  return rodentFiltered
    .filter((m) => rankByMovieId.has(m.id))
    .sort((a, b) => (rankByMovieId.get(b.id) ?? 0) - (rankByMovieId.get(a.id) ?? 0));
}

export async function getCatalogGenres() {
  const allMovies = await getCatalogMovies();
  return Array.from(new Set(allMovies.flatMap((movie) => movie.genres))).sort();
}

export async function getCatalogRodentTypes(): Promise<string[]> {
  return RODENT_TYPE_OPTIONS.map((r) => r.id);
}

export async function getCatalogStatsWithCommunity() {
  const pool = getDbPool();
  const [movieCount, sightingCount, spoilerCount] = await Promise.all([
    pool.query<{ count: string }>(
      `select count(*)::text as count from movies where is_deleted = false`,
    ),
    pool.query<{ count: string }>(
      `select count(*)::text as count from sightings where is_deleted = false`,
    ),
    pool.query<{ count: string }>(
      `select count(*)::text as count from sightings where is_deleted = false and spoiler = true`,
    ),
  ]);
  const sightingRows = await pool.query<{
    approximate_rat_count: number | null;
    scene_type: string;
  }>(
    `select approximate_rat_count, scene_type
     from sightings
     where is_deleted = false`,
  );
  const ratsTallied = sightingRows.rows.reduce((sum, row) => {
    if (typeof row.approximate_rat_count === "number" && row.approximate_rat_count >= 1) {
      return sum + Math.min(9999, Math.floor(row.approximate_rat_count));
    }
    return sum + (row.scene_type === "swarm" ? 6 : 1);
  }, 0);
  return {
    movies: Number(movieCount.rows[0]?.count ?? "0") || 0,
    sightings: Number(sightingCount.rows[0]?.count ?? "0") || 0,
    spoilerSightings: Number(spoilerCount.rows[0]?.count ?? "0") || 0,
    ratsTallied,
  };
}
