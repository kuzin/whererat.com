import { normalizeImdbId, type Movie, type Submission } from "@/lib/whererat";
import { getDbPool } from "@/lib/db";
import { invalidateCatalogCache } from "@/lib/catalog-cache";
import { syncMovieFromImdb } from "@/lib/movie-imdb-sync";
import { MAX_RELEASE_YEAR, MIN_RELEASE_YEAR, sanitizePosterUrl } from "@/lib/submission-input";

function slugifyTitle(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

type MovieRow = Parameters<typeof rowToMovie>[0];

const MOVIE_COLUMNS =
  "id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, metadata, summary";

/** `release_year` has a check constraint (> 1800, < 3000); anything else would make the INSERT throw. */
function releaseYearOrCurrent(year: number | undefined): number {
  const whole = typeof year === "number" && Number.isFinite(year) ? Math.floor(year) : NaN;
  return whole >= MIN_RELEASE_YEAR && whole <= MAX_RELEASE_YEAR ? whole : new Date().getFullYear();
}

const COMMUNITY_POSTER_FALLBACK =
  "https://placehold.co/600x900/292524/fef3c7/png?text=Community+Movie";

function normalizePosterUrl(value: string | undefined) {
  return sanitizePosterUrl(value) ?? COMMUNITY_POSTER_FALLBACK;
}

function rowToMovie(row: {
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
  metadata: Movie["metadata"];
  summary: string;
}): Movie {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    releaseYear: row.release_year,
    runtimeMinutes: row.runtime_minutes,
    genres: row.genres,
    posterTone: row.poster_tone,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    posterAlt: row.poster_alt,
    externalIds: {
      imdb: row.imdb_id,
      tmdb: row.tmdb_id ?? undefined,
    },
    metadata: row.metadata,
    summary: row.summary,
  };
}

export async function ensureCommunityMovieForSubmission(
  submission: Pick<Submission, "movieTitle" | "movieYear" | "imdbId" | "moviePosterUrl" | "description">,
) {
  const title = submission.movieTitle.trim();
  if (!title) return undefined;
  const imdbId = normalizeImdbId(submission.imdbId ?? "");
  if (!imdbId) {
    throw new Error(
      "Cannot add a catalog movie without an IMDb title ID (tt…). Use search results when submitting, or ask a moderator to attach an IMDb ID before approving.",
    );
  }

  const pool = getDbPool();
  // The IMDb id is the identity: two different titles can share a name ("Life").
  const live = await pool.query<MovieRow>(
    `select ${MOVIE_COLUMNS} from movies where imdb_id = $1 and is_deleted = false`,
    [imdbId],
  );
  if (live.rows[0]) return rowToMovie(live.rows[0]);

  // A deleted movie still owns its imdb_id / slug (UNIQUE is not partial), so an
  // explicit approval brings it back instead of colliding with it.
  const restored = await pool.query<MovieRow>(
    `update movies set is_deleted = false, updated_at = now()
     where imdb_id = $1
     returning ${MOVIE_COLUMNS}`,
    [imdbId],
  );
  if (restored.rows[0]) {
    invalidateCatalogCache();
    return rowToMovie(restored.rows[0]);
  }

  const releaseYear = releaseYearOrCurrent(submission.movieYear);
  const slugBase = `${slugifyTitle(title) || imdbId}-${releaseYear}`;
  const metadata: Movie["metadata"] = {
    tagline: "",
    rating: "Not Rated",
    director: "",
    originalLanguage: "Unknown",
    productionCountries: [],
    metadataProvider: "IMDb seed",
    lastSyncedAt: new Date().toISOString().slice(0, 10),
    writers: "",
    cast: "",
    imdbRating: "",
    imdbVotes: "",
    metascore: "",
    awards: "",
  };

  // Slugs (and ids derived from them) are unique across deleted rows too. If a
  // concurrent approval takes the slug between our read and insert, pick again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slugRows = await pool.query<{ slug: string }>(`select slug from movies`);
    const taken = new Set(slugRows.rows.map((row) => row.slug));
    let slug = slugBase;
    for (let bump = 2; taken.has(slug); bump += 1) slug = `${slugBase}-${bump}`;

    try {
      const inserted = await pool.query<MovieRow>(
        `insert into movies
          (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, summary, metadata, is_deleted)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null,$12,$13,false)
         on conflict (imdb_id) do nothing
         returning ${MOVIE_COLUMNS}`,
        [
          `community-${slug}`,
          slug,
          title,
          releaseYear,
          1,
          ["Uncategorized"],
          "bg-stone-700",
          normalizePosterUrl(submission.moviePosterUrl),
          "https://placehold.co/1200x600/292524/fef3c7/png?text=Community+Movie",
          `Poster for ${title}.`,
          imdbId,
          submission.description.trim() || "Community-submitted movie entry.",
          metadata,
        ],
      );
      if (!inserted.rows[0]) {
        // Lost a race on imdb_id: the other approval created it, so use theirs.
        const winner = await pool.query<MovieRow>(
          `select ${MOVIE_COLUMNS} from movies where imdb_id = $1`,
          [imdbId],
        );
        if (winner.rows[0]) return rowToMovie(winner.rows[0]);
        continue;
      }
      const newMovie = rowToMovie(inserted.rows[0]);
      invalidateCatalogCache();

      // Fire-and-forget: enrich with OMDb metadata and IMDb rat facts.
      // Never blocks approval: a failed enrichment is logged and retried by the cron resync.
      void Promise.resolve(syncMovieFromImdb(newMovie)).catch((error) => {
        console.warn("[community-movie] IMDb enrichment failed:", error instanceof Error ? error.message : error);
      });

      return newMovie;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a catalog entry for this title. Please try again.");
}
