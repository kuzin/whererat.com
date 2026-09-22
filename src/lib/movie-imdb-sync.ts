import { updateMovieOverride } from "@/lib/movie-edit-store";
import { getCatalogMovies } from "@/lib/movie-catalog";
import { fetchTmdbYoutubeTrailerKey } from "@/lib/tmdb-banner";
import { upsizeAmazonPosterUrl } from "@/lib/amazon-poster-url";
import { extractMoviePagePalette, deriveDarkMoviePagePalette, type MoviePagePalette } from "@/lib/movie-page-palette";
import type { ImdbImage, ImdbRelatedTitle, ImdbReview, ImdbVideo, Movie } from "@/lib/whererat";

// ---------------------------------------------------------------------------
// HTML / text helpers
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&ldquo;": "\u201c",
  "&rdquo;": "\u201d",
};

function decodeEntities(s: string): string {
  return s.replace(/&[a-z]+;|&#\d+;/gi, (e) => HTML_ENTITIES[e] ?? e);
}

function stripHtml(html: string): string {
  const stripped = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Two passes: first decodes &amp;#39; → &#39;, second decodes &#39; → '
  return decodeEntities(decodeEntities(stripped));
}

function mentionsRodent(text: string): boolean {
  return /\b(rats?|ratty|rat-like|rat-proof|ratcatcher|mice|mouse|rodents?|gerbils?|hamsters?|squirrels?|voles?|beavers?|marmots?|guinea\s+pigs?|murine|vermin)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// OMDb
// ---------------------------------------------------------------------------

type OmdbFullDetails = {
  Title: string;
  Year: string;
  Type?: string;
  totalSeasons?: string;
  TotalSeasons?: string;
  Rated?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Writer?: string;
  Actors?: string;
  Plot?: string;
  Language?: string;
  Country?: string;
  Awards?: string;
  Poster?: string;
  Metascore?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Response: "True" | "False";
};

type OmdbSeasonDetails = {
  Response: "True" | "False";
  Episodes?: Array<{ Episode?: string }>;
};

function omdbStr(val: string | undefined) {
  return val && val !== "N/A" ? val.trim() : undefined;
}

async function fetchOmdbData(
  imdbId: string,
  apiKey: string,
): Promise<OmdbFullDetails | undefined> {
  try {
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("i", imdbId);
    url.searchParams.set("plot", "full");
    const res = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as OmdbFullDetails;
    return json.Response === "True" ? json : undefined;
  } catch {
    return undefined;
  }
}

// Cap per-season lookups so a long-running series doesn't make hundreds of OMDb calls
const MAX_SEASONS_TO_COUNT = 20;

async function fetchOmdbTotalEpisodeCount(params: {
  imdbId: string;
  apiKey: string;
  totalSeasonsRaw?: string;
}): Promise<number | undefined> {
  const totalSeasons = Number.parseInt(params.totalSeasonsRaw ?? "", 10);
  if (!Number.isFinite(totalSeasons) || totalSeasons < 1) return undefined;
  const cappedSeasons = Math.min(MAX_SEASONS_TO_COUNT, totalSeasons);
  let totalEpisodes = 0;

  for (let season = 1; season <= cappedSeasons; season++) {
    try {
      const url = new URL("https://www.omdbapi.com/");
      url.searchParams.set("apikey", params.apiKey);
      url.searchParams.set("i", params.imdbId);
      url.searchParams.set("Season", String(season));
      const res = await fetch(url.toString(), {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as OmdbSeasonDetails;
      if (json.Response !== "True") continue;
      totalEpisodes += Array.isArray(json.Episodes) ? json.Episodes.length : 0;
    } catch {
      // Ignore season-level errors; keep best-effort total from successful seasons.
    }
  }

  return totalEpisodes > 0 ? totalEpisodes : undefined;
}

// ---------------------------------------------------------------------------
// IMDb trivia (public GraphQL, no key required)
// ---------------------------------------------------------------------------

const IMDB_GRAPHQL_URL = "https://api.graphql.imdb.com/";

/**
 * IMDb's public GraphQL endpoint rejects requests without a Referer with a bare 403.
 * Every caller here degrades to an empty result, so a missing header shows up as a
 * movie page with no reviews/media/related rather than as an error — keep the header,
 * and log failures so the next outage isn't silent.
 */
async function fetchImdbGraphql<T>(
  label: string,
  query: string,
): Promise<T | undefined> {
  try {
    const res = await fetch(IMDB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Referer: "https://www.imdb.com/",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[imdb-sync] ${label}: HTTP ${res.status}`);
      return undefined;
    }
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) {
      console.warn(`[imdb-sync] ${label}: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    return json.data;
  } catch (error) {
    console.warn(
      `[imdb-sync] ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function fetchImdbTrivia(imdbId: string): Promise<unknown[]> {
  const data = await fetchImdbGraphql<{ title?: { trivia?: { edges?: unknown[] } } }>(
    `trivia ${imdbId}`,
    `
      query {
        title(id: "${imdbId}") {
          trivia(first: 50) {
            edges {
              node {
                id
                displayableArticle {
                  body {
                    plaidHtml
                  }
                }
              }
            }
          }
        }
      }
    `,
  );
  return data?.title?.trivia?.edges ?? [];
}

// ---------------------------------------------------------------------------
// IMDb user reviews (public GraphQL, no key required)
// ---------------------------------------------------------------------------

async function fetchImdbReviews(imdbId: string): Promise<unknown[]> {
  const data = await fetchImdbGraphql<{ title?: { reviews?: { edges?: unknown[] } } }>(
    `reviews ${imdbId}`,
    `
      query {
        title(id: "${imdbId}") {
          reviews(first: 20) {
            edges {
              node {
                id
                author { nickName }
                summary { originalText }
                text { originalText { plainText } }
                authorRating
                submissionDate
              }
            }
          }
        }
      }
    `,
  );
  return data?.title?.reviews?.edges ?? [];
}

/** Normalise an IMDb date string (various formats) to "YYYY-MM-DD". */
function normaliseImdbDate(raw: string | undefined): string {
  if (!raw) return "";
  // Already ISO-ish: "2003-04-12" or "2003-04-12T00:00:00Z"
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  // Human format: "12 April 2003"
  const humanMatch = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (humanMatch) {
    const months: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04",
      may: "05", june: "06", july: "07", august: "08",
      september: "09", october: "10", november: "11", december: "12",
    };
    const m = months[humanMatch[2].toLowerCase()];
    if (m) return `${humanMatch[3]}-${m}-${humanMatch[1].padStart(2, "0")}`;
  }
  return raw;
}

function extractReviews(edges: unknown[]): ImdbReview[] {
  const reviews: ImdbReview[] = [];
  for (const edge of edges) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = (edge as any)?.node;
    if (!node) continue;

    const summary: string = stripHtml(node.summary?.originalText ?? "");
    const text: string = stripHtml(node.text?.originalText?.plainText ?? "");
    if (!summary && !text) continue;

    const author: string = node.author?.nickName ?? "Anonymous";
    const ratingRaw = node.authorRating;
    const rating = typeof ratingRaw === "number" ? ratingRaw : undefined;
    const date = normaliseImdbDate(node.submissionDate as string | undefined);
    const combined = `${summary} ${text}`;

    reviews.push({
      id: String(node.id ?? reviews.length),
      author,
      summary,
      text,
      rating,
      date,
      mentionsRat: mentionsRodent(combined),
    });
  }
  return reviews;
}

function extractRatFacts(edges: unknown[]): string[] {
  const facts: string[] = [];
  for (const edge of edges) {
    if (facts.length >= 5) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: string = (edge as any)?.node?.displayableArticle?.body?.plaidHtml ?? "";
    if (!raw) continue;
    const plain = stripHtml(String(raw));
    if (plain && mentionsRodent(plain)) facts.push(plain);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// IMDb "more like this" recommendations (public GraphQL)
// ---------------------------------------------------------------------------

export async function fetchImdbRelated(imdbId: string): Promise<ImdbRelatedTitle[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await fetchImdbGraphql<Record<string, any>>(
      `related ${imdbId}`,
      `
      query {
        title(id: "${imdbId}") {
          moreLikeThisTitles(first: 12) {
            edges {
              node {
                id
                titleText { text }
                releaseYear { year }
                primaryImage { url }
                ratingsSummary { aggregateRating }
              }
            }
          }
        }
      }
    `,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edges: any[] = data?.title?.moreLikeThisTitles?.edges ?? [];
    return edges.flatMap((edge) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = (edge as any)?.node;
      if (!node?.id || !node?.titleText?.text) return [];
      return [
        {
          id: String(node.id),
          title: String(node.titleText.text),
          year: node.releaseYear?.year ?? undefined,
          posterUrl: node.primaryImage?.url ?? undefined,
          rating: node.ratingsSummary?.aggregateRating ?? undefined,
        } satisfies ImdbRelatedTitle,
      ];
    });
}

// ---------------------------------------------------------------------------
// IMDb videos + images (public GraphQL, single combined query)
// ---------------------------------------------------------------------------

export async function fetchImdbMedia(
  imdbId: string,
): Promise<{ videos: ImdbVideo[]; images: ImdbImage[] }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await fetchImdbGraphql<Record<string, any>>(
      `media ${imdbId}`,
      `
      query {
        title(id: "${imdbId}") {
          primaryVideos(first: 10) {
            edges {
              node {
                id
                name { value }
                runtime { value }
                thumbnail { url }
                contentType { displayName { value } }
              }
            }
          }
          images(first: 24) {
            edges {
              node {
                id
                url
                width
                height
                caption { plainText }
              }
            }
          }
        }
      }
    `,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const videoEdges: any[] = data?.title?.primaryVideos?.edges ?? [];
    const videos: ImdbVideo[] = videoEdges.flatMap((edge) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = (edge as any)?.node;
      if (!node?.id) return [];
      return [
        {
          id: String(node.id),
          name: String(node.name?.value ?? "Video"),
          contentType: node.contentType?.displayName?.value ?? undefined,
          thumbnailUrl: node.thumbnail?.url ?? undefined,
          runtimeSeconds: node.runtime?.value ?? undefined,
        } satisfies ImdbVideo,
      ];
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageEdges: any[] = data?.title?.images?.edges ?? [];
    const images: ImdbImage[] = imageEdges.flatMap((edge) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = (edge as any)?.node;
      if (!node?.id || !node?.url) return [];
      return [
        {
          id: String(node.id),
          url: String(node.url),
          width: typeof node.width === "number" ? node.width : undefined,
          height: typeof node.height === "number" ? node.height : undefined,
          caption: node.caption?.plainText ?? undefined,
        } satisfies ImdbImage,
      ];
    });

    return { videos, images };
}

// ---------------------------------------------------------------------------
// Combined sync
// ---------------------------------------------------------------------------

/**
 * Pull fresh metadata from OMDb and rat facts from IMDb's public GraphQL API,
 * then write them as an override for the given movie.
 *
 * Safe to call fire-and-forget — all errors are swallowed so the caller is
 * never blocked on a network failure.
 */
export async function syncMovieFromImdb(movie: Movie): Promise<void> {
  const imdbId = movie.externalIds.imdb;
  if (!imdbId) return;

  const apiKey = process.env.OMDB_API_KEY;

  // Run all fetches in parallel
  const [omdb, triviaEdges, reviewEdges, imdbRelated, imdbMedia, youtubeTrailerKey] = await Promise.all([
    apiKey ? fetchOmdbData(imdbId, apiKey) : Promise.resolve(undefined),
    fetchImdbTrivia(imdbId),
    fetchImdbReviews(imdbId),
    fetchImdbRelated(imdbId),
    fetchImdbMedia(imdbId),
    fetchTmdbYoutubeTrailerKey({ imdbId, tmdbId: movie.externalIds.tmdb }),
  ]);

  const ratFacts = extractRatFacts(triviaEdges);
  const imdbReviews = extractReviews(reviewEdges);

  const runtimeMinutes = omdb?.Runtime
    ? Number.parseInt(omdb.Runtime, 10) || undefined
    : undefined;
  const genres = omdbStr(omdb?.Genre)
    ? omdb!.Genre!.split(",").map((g) => g.trim()).filter(Boolean)
    : undefined;
  const productionCountries = omdbStr(omdb?.Country)
    ? omdb!.Country!.split(",").map((c) => c.trim()).filter(Boolean)
    : undefined;
  const posterUrl =
    omdb?.Poster && omdb.Poster !== "N/A" ? omdb.Poster : undefined;

  // Extract palette from poster (best-effort, stored so page loads skip re-processing)
  const paletteSourceUrl = upsizeAmazonPosterUrl(posterUrl ?? movie.posterUrl) || posterUrl || movie.posterUrl;
  let syncedPalette: MoviePagePalette | null = null;
  let syncedPaletteDark: MoviePagePalette | null = null;
  if (paletteSourceUrl) {
    try {
      const p = await extractMoviePagePalette(paletteSourceUrl);
      if (p) {
        syncedPalette = p;
        syncedPaletteDark = deriveDarkMoviePagePalette(p);
      }
    } catch {
      // palette extraction is best-effort
    }
  }
  const totalEpisodes = apiKey
    ? await fetchOmdbTotalEpisodeCount({
      imdbId,
      apiKey,
      totalSeasonsRaw: omdb?.totalSeasons ?? omdb?.TotalSeasons,
    })
    : undefined;
  const prevSyncSnapshot =
    movie.metadata.syncSnapshot && typeof movie.metadata.syncSnapshot === "object"
      ? movie.metadata.syncSnapshot
      : {};
  const nextSyncSnapshot: Record<string, unknown> = {
    ...prevSyncSnapshot,
    ...(omdb?.Year ? { Year: omdb.Year } : {}),
    ...(omdbStr(omdb?.Type) ? { Type: omdb!.Type } : {}),
    ...(omdbStr(omdb?.totalSeasons) ? { totalSeasons: omdb!.totalSeasons } : {}),
    ...(omdbStr(omdb?.TotalSeasons) ? { TotalSeasons: omdb!.TotalSeasons } : {}),
    ...(Number.isFinite(totalEpisodes) ? { totalEpisodes } : {}),
  };

  await updateMovieOverride(movie.id, {
    ...(omdb && omdbStr(omdb.Title) ? { title: omdb.Title } : {}),
    ...(omdb?.Year ? { releaseYear: Number.parseInt(omdb.Year, 10) || movie.releaseYear } : {}),
    ...(runtimeMinutes ? { runtimeMinutes } : {}),
    ...(genres ? { genres } : {}),
    ...(omdb && omdbStr(omdb.Plot) ? { summary: omdb.Plot } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    metadata: {
      ...movie.metadata,
      ...(omdb && omdbStr(omdb.Rated) ? { rating: omdb.Rated } : {}),
      ...(omdb && omdbStr(omdb.Director) ? { director: omdb.Director } : {}),
      ...(omdb && omdbStr(omdb.Writer) ? { writers: omdb.Writer } : {}),
      ...(omdb && omdbStr(omdb.Actors) ? { cast: omdb.Actors } : {}),
      ...(omdb && omdbStr(omdb.imdbRating) ? { imdbRating: omdb.imdbRating } : {}),
      ...(omdb && omdbStr(omdb.imdbVotes) ? { imdbVotes: omdb.imdbVotes } : {}),
      ...(omdb && omdbStr(omdb.Metascore) ? { metascore: omdb.Metascore } : {}),
      ...(omdb && omdbStr(omdb.Awards) ? { awards: omdb.Awards } : {}),
      ...(omdb && omdbStr(omdb.Language) ? { originalLanguage: omdb.Language } : {}),
      ...(productionCountries ? { productionCountries } : {}),
      metadataProvider: "OMDb via IMDb ID",
      lastSyncedAt: new Date().toISOString().slice(0, 10),
      syncSnapshot: nextSyncSnapshot,
      ...(ratFacts.length > 0 ? { ratFacts } : {}),
      ...(imdbReviews.length > 0 ? { imdbReviews } : {}),
      ...(imdbRelated.length > 0 ? { imdbRelated } : {}),
      ...(imdbMedia.videos.length > 0 ? { imdbVideos: imdbMedia.videos } : {}),
      ...(imdbMedia.images.length > 0 ? { imdbImages: imdbMedia.images } : {}),
      ...(youtubeTrailerKey ? { youtubeTrailerKey } : {}),
      ...(syncedPalette ? { syncedPalette } : {}),
      ...(syncedPaletteDark ? { syncedPaletteDark } : {}),
    },
  });
}

export type ResyncAllCatalogMoviesOptions = {
  /**
   * Stop after roughly this duration. Use on Vercel Hobby (10s function cap) so cron
   * still completes with partial progress; omit for a full synchronous run.
   */
  maxDurationMs?: number;
  /**
   * Rotate iteration order so each shortened run advances through the catalog.
   * Ignored when staleness sorting is active (movies with oldest/missing sync go first).
   */
  rotationSeed?: number;
  /**
   * Number of movies to sync in parallel. Defaults to 1 (sequential).
   * Keep low (2–3) to stay within OMDb rate limits.
   */
  concurrency?: number;
};

function getLastSyncedAt(movie: { metadata: Record<string, unknown> }): number {
  const raw = movie.metadata.lastSyncedAt;
  if (typeof raw !== "string") return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/** Sort movies so never-synced titles go first, then oldest-synced first. */
function sortByStaleFirst(movies: Movie[]): Movie[] {
  return [...movies].sort((a, b) => getLastSyncedAt(a) - getLastSyncedAt(b));
}

/** Resync catalog titles from OMDb/IMDb (moderation owner action + cron). */
export async function resyncAllCatalogMoviesFromImdb(
  opts?: ResyncAllCatalogMoviesOptions,
): Promise<{
  total: number;
  synced: number;
  errors: number;
  truncated: boolean;
}> {
  const movies = await getCatalogMovies();
  const total = movies.length;

  // Stale-first: movies never synced or synced longest ago go first.
  // Fall back to rotation seed only when all movies have a sync timestamp.
  let order = sortByStaleFirst(movies);
  const allHaveSyncedAt = order.every((m) => getLastSyncedAt(m) > 0);
  if (allHaveSyncedAt) {
    // All caught up — use rotation seed to vary which stale movies we hit
    const seed = opts?.rotationSeed;
    if (typeof seed === "number" && Number.isFinite(seed) && order.length > 0) {
      const rot = ((Math.floor(seed) % order.length) + order.length) % order.length;
      order = [...order.slice(rot), ...order.slice(0, rot)];
    }
  }

  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 1, 5));
  let synced = 0;
  let errors = 0;
  const deadlineMs = opts?.maxDurationMs;
  const deadline =
    typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0
      ? Date.now() + deadlineMs
      : null;
  let truncated = false;

  for (let i = 0; i < order.length; i += concurrency) {
    if (deadline != null && Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const batch = order.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((movie) => syncMovieFromImdb(movie)));
    for (const result of results) {
      if (result.status === "fulfilled") {
        synced++;
      } else {
        errors++;
      }
    }
  }

  return { total, synced, errors, truncated };
}
