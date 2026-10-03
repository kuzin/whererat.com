import { normalizeImdbId, type Movie, type Submission } from "@/lib/whererat";
import { getDbPool } from "@/lib/db";
import { syncMovieFromImdb } from "@/lib/movie-imdb-sync";

function slugifyTitle(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const COMMUNITY_POSTER_FALLBACK =
  "https://placehold.co/600x900/292524/fef3c7/png?text=Community+Movie";

function normalizePosterUrl(value: string | undefined) {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "N/A") return COMMUNITY_POSTER_FALLBACK;
  if (raw.startsWith("/") || /^https?:\/\//i.test(raw)) return raw;
  return COMMUNITY_POSTER_FALLBACK;
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

export async function getCommunityMovies() {
  await backfillCommunityMoviesFromApprovedSubmissions();
  const pool = getDbPool();
  const result = await pool.query<{
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
  }>(
    `select id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, metadata, summary
     from movies
     where id like 'community-%' and is_deleted = false
     order by created_at desc`,
  );
  return result.rows
    .filter((row) => Boolean(normalizeImdbId(row.imdb_id)))
    .map(rowToMovie);
}

async function backfillCommunityMoviesFromApprovedSubmissions() {
  const pool = getDbPool();
  const approvedRes = await pool.query<{
    movie_title: string;
    movie_year: number | null;
    imdb_id: string | null;
    movie_poster_url: string | null;
    description: string;
  }>(
    `select movie_title, movie_year, imdb_id, movie_poster_url, description
     from submissions
     where status = 'approved'`,
  );
  const approved = approvedRes.rows.map((row) => ({
    movieTitle: row.movie_title,
    movieYear: row.movie_year ?? undefined,
    imdbId: row.imdb_id ?? undefined,
    moviePosterUrl: row.movie_poster_url ?? undefined,
    description: row.description,
  })) as Submission[];
  if (approved.length === 0) return;

  const existingRows = await pool.query<{ id: string; slug: string; title: string; imdb_id: string }>(
    `select id, slug, title, imdb_id from movies where is_deleted = false`,
  );
  const current = existingRows.rows;

  for (const submission of approved) {
    const title = submission.movieTitle?.trim();
    if (!title) continue;
    const imdbId = normalizeImdbId(submission.imdbId ?? "");
    if (!imdbId) continue;
    const exists = current.some((movie) => {
      if (imdbId && movie.imdb_id === imdbId) return true;
      return movie.title.trim().toLowerCase() === title.toLowerCase();
    });
    if (exists) continue;

    const releaseYear =
      typeof submission.movieYear === "number" && Number.isFinite(submission.movieYear)
        ? Math.floor(submission.movieYear)
        : new Date().getFullYear();
    const slugBase = `${slugifyTitle(title)}-${releaseYear}`;
    const taken = new Set(current.map((movie) => movie.slug));
    let slug = slugBase || `submission-${releaseYear}`;
    let bump = 2;
    while (taken.has(slug)) {
      slug = `${slugBase}-${bump}`;
      bump += 1;
    }

    await pool.query(
      `insert into movies
        (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, summary, metadata, is_deleted)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null,$12,$13,false)`,
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
        {
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
        },
      ],
    );
    current.push({
      id: `community-${slug}`,
      slug,
      title,
      imdb_id: imdbId,
    });
  }
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
  const allMoviesRes = await pool.query<{
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
  }>(
    `select id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, metadata, summary
     from movies
     where is_deleted = false`,
  );
  const allMovies = allMoviesRes.rows;
  // The IMDb id is the identity: two different titles can share a name ("Life").
  const existing = allMovies.find((movie) => movie.imdb_id === imdbId);
  if (existing) return rowToMovie(existing);

  const releaseYear =
    typeof submission.movieYear === "number" && Number.isFinite(submission.movieYear)
      ? Math.floor(submission.movieYear)
      : new Date().getFullYear();
  const slugBase = `${slugifyTitle(title)}-${releaseYear}`;
  const taken = new Set(allMovies.map((movie) => movie.slug));
  let slug = slugBase || `submission-${releaseYear}`;
  let bump = 2;
  while (taken.has(slug)) {
    slug = `${slugBase}-${bump}`;
    bump += 1;
  }

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
  const inserted = await pool.query<{
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
  }>(
    `insert into movies
      (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, summary, metadata, is_deleted)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null,$12,$13,false)
     returning id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, tmdb_id, metadata, summary`,
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
  const newMovie = rowToMovie(inserted.rows[0]);

  // Fire-and-forget: enrich with OMDb metadata and IMDb rat facts.
  // Errors are swallowed inside syncMovieFromImdb so approval is never blocked.
  void syncMovieFromImdb(newMovie);

  return newMovie;
}
