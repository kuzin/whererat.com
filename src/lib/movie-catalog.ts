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
  // A single leading slash only: "//host/x.png" and "/\\host" are off-site URLs, not local paths.
  if (/^\/(?![/\\])/.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return fallback;
}

function rowToMovie(row: MovieRow): Movie {
  return {
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
  };
}

const MOVIE_COLUMNS = `id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, summary`;

/** Every movie with its complete metadata. Use for detail pages and anything that edits/syncs a title. */
export async function getCatalogMovies(): Promise<Movie[]> {
  const pool = getDbPool();
  const result = await pool.query<MovieRow>(
    `select ${MOVIE_COLUMNS}, metadata
     from movies
     where is_deleted = false
     order by created_at asc`,
  );
  return result.rows.filter((row) => hasValidImdbId(row.imdb_id)).map(rowToMovie);
}

/**
 * Top-level metadata keys that list views (home, v1 catalog, sitemap-style scans) read.
 * Everything else — reviews, related titles, stills, videos, cast, the raw IMDb snapshot —
 * is the bulk of a movie row and stays in Postgres.
 */
const LIST_METADATA_KEYS = [
  "rating",
  "imdbRating",
  "imdbVotes",
  "overrideAccent",
  "pagePalette",
  "pagePaletteDark",
  "syncedPalette",
  "syncedPaletteDark",
  "syncedHeaderBannerUrl",
];
/** `syncSnapshot` fields read by list cards and `getMoviePath` (series vs. movie). */
const LIST_SNAPSHOT_KEYS = [
  "Type",
  "Year",
  "year",
  "totalSeasons",
  "TotalSeasons",
  "totalEpisodes",
  "TotalEpisodes",
  "episodeCount",
];

/**
 * Catalog movies for list views. Same shape as {@link getCatalogMovies}, but `metadata`
 * only carries {@link LIST_METADATA_KEYS} (+ a trimmed `syncSnapshot`), projected in SQL so
 * the heavy JSONB never crosses the wire. Do not use it to render or edit a single title.
 */
export async function getCatalogListMovies(): Promise<Movie[]> {
  const pool = getDbPool();
  const result = await pool.query<MovieRow>(
    `select ${MOVIE_COLUMNS},
       case when jsonb_typeof(metadata) = 'object' then
         (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
            from jsonb_each(metadata) e where e.key = any($1::text[]))
         || case when jsonb_typeof(metadata->'syncSnapshot') = 'object' then
              jsonb_build_object('syncSnapshot',
                (select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
                   from jsonb_each(metadata->'syncSnapshot') s where s.key = any($2::text[])))
            else '{}'::jsonb end
       else '{}'::jsonb end as metadata
     from movies
     where is_deleted = false
     order by created_at asc`,
    [LIST_METADATA_KEYS, LIST_SNAPSHOT_KEYS],
  );
  return result.rows.filter((row) => hasValidImdbId(row.imdb_id)).map(rowToMovie);
}

/** One movie by slug — a single-row read, not a scan of the whole catalog. */
export async function getCatalogMovieBySlug(slug: string) {
  const pool = getDbPool();
  const result = await pool.query<MovieRow>(
    `select ${MOVIE_COLUMNS}, metadata
     from movies
     where slug = $1 and is_deleted = false
     limit 1`,
    [slug],
  );
  const row = result.rows[0];
  return row && hasValidImdbId(row.imdb_id) ? rowToMovie(row) : undefined;
}

export async function getCatalogMovieByImdbId(imdbIdOrUrl: string) {
  const imdbId = normalizeImdbId(imdbIdOrUrl);
  if (!imdbId) return undefined;
  const allMovies = await getCatalogMovies();
  return allMovies.find((movie) => movie.externalIds.imdb === imdbId);
}

/** Undefined when the search finds nothing — every caller already guards for it. */
export async function getCatalogMovieByTitleSearch(title: string): Promise<Movie | undefined> {
  const results = await searchCatalogMovies({ query: title });
  return results[0];
}

type SubmissionMovieRef = { imdbId?: string | null; movieTitle: string };

/** The few fields needed to match a submission to a movie. */
export type CatalogIdentity = Pick<Movie, "id" | "title" | "externalIds">;

/** Every visible movie's identity only (no metadata/summary) — cheap enough to read per request. */
export async function getCatalogIdentities(): Promise<CatalogIdentity[]> {
  const pool = getDbPool();
  const result = await pool.query<{ id: string; title: string; imdb_id: string }>(
    `select id, title, imdb_id
     from movies
     where is_deleted = false
     order by created_at asc`,
  );
  return result.rows
    .filter((row) => hasValidImdbId(row.imdb_id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      externalIds: { imdb: normalizeImdbId(row.imdb_id) },
    }));
}

/** Indexes over a movie list so resolving a submission is a map lookup, not a scan. */
export type CatalogLookup<T extends CatalogIdentity = Movie> = {
  byImdbId: Map<string, T>;
  /** Lower-cased, trimmed title -> first movie with that title (catalog order). */
  byTitle: Map<string, T>;
};

export function buildCatalogLookup<T extends CatalogIdentity>(
  movies: readonly T[],
): CatalogLookup<T> {
  const byImdbId = new Map<string, T>();
  const byTitle = new Map<string, T>();
  for (const movie of movies) {
    if (!byImdbId.has(movie.externalIds.imdb)) byImdbId.set(movie.externalIds.imdb, movie);
    const title = movie.title.trim().toLowerCase();
    if (!byTitle.has(title)) byTitle.set(title, movie);
  }
  return { byImdbId, byTitle };
}

/**
 * Which catalog movie a submission belongs to.
 *
 * An IMDb id is authoritative: when the submission has one, only a movie with
 * that id matches. We must not fall back to `getCatalogMovieByTitleSearch` there —
 * it is a fuzzy full-text search (it also reads movie summaries), so a short
 * title like "Life" can land on an unrelated movie such as Downton Abbey.
 * Without an id, only an exact (case-insensitive) title match counts.
 */
export function resolveMovieForSubmission<T extends CatalogIdentity>(
  submission: SubmissionMovieRef,
  lookup: CatalogLookup<T>,
): T | undefined {
  const imdbId = normalizeImdbId(submission.imdbId ?? "");
  if (imdbId) return lookup.byImdbId.get(imdbId);
  const wanted = submission.movieTitle.trim().toLowerCase();
  if (!wanted) return undefined;
  return lookup.byTitle.get(wanted);
}

/**
 * Async single-submission form of {@link resolveMovieForSubmission}. Pass `movies` when
 * resolving several submissions so the catalog is read once, not once per call.
 */
export async function findCatalogMovieForSubmission(
  submission: SubmissionMovieRef,
  movies?: readonly Movie[],
): Promise<Movie | undefined> {
  const imdbId = normalizeImdbId(submission.imdbId ?? "");
  if (!imdbId && !submission.movieTitle.trim()) return undefined;
  return resolveMovieForSubmission(
    submission,
    buildCatalogLookup(movies ?? (await getCatalogMovies())),
  );
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
      OR lower(m.imdb_id) = lower($1)
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
      OR lower(m.imdb_id) = lower($1)
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
  movies,
}: {
  query?: string;
  genre?: string;
  /** Movies to search within; defaults to the full catalog. List views pass the slim list. */
  movies?: Movie[];
  /**
   * Movie ids matching the active rodent-type filter, or undefined for no filter.
   * Resolved by the caller via `getMovieIdsWithRodentType` — visible sightings are
   * merged from approved submissions, which lives in moderation-store and would be
   * a circular import here.
   */
  rodentMovieIds?: Set<string>;
}): Promise<Movie[]> {
  const allMovies = movies ?? (await getCatalogMovies());
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

export async function getCatalogGenres(movies?: readonly Movie[]) {
  const allMovies = movies ?? (await getCatalogMovies());
  return Array.from(new Set(allMovies.flatMap((movie) => movie.genres))).sort();
}

export async function getCatalogRodentTypes(): Promise<string[]> {
  return RODENT_TYPE_OPTIONS.map((r) => r.id);
}

export async function getCatalogStatsWithCommunity() {
  const pool = getDbPool();
  // Same per-row rule as estimateRatsForAppearance: a usable count wins (clamped),
  // otherwise a swarm scene is ~6 rats and anything else is 1.
  const [movieCount, sightingStats] = await Promise.all([
    pool.query<{ count: string }>(
      `select count(*)::text as count from movies where is_deleted = false`,
    ),
    pool.query<{ sightings: string; spoilers: string; rats: string }>(
      `select count(*)::text as sightings,
              (count(*) filter (where spoiler = true))::text as spoilers,
              coalesce(sum(
                case
                  when approximate_rat_count >= 1 then least(9999, floor(approximate_rat_count))
                  when scene_type = 'swarm' then 6
                  else 1
                end
              ), 0)::text as rats
       from sightings
       where is_deleted = false`,
    ),
  ]);
  const stats = sightingStats.rows[0];
  return {
    movies: Number(movieCount.rows[0]?.count ?? "0") || 0,
    sightings: Number(stats?.sightings ?? "0") || 0,
    spoilerSightings: Number(stats?.spoilers ?? "0") || 0,
    ratsTallied: Number(stats?.rats ?? "0") || 0,
  };
}
