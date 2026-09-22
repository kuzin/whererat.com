import { NextResponse } from "next/server";
import type { Movie } from "@/lib/whererat";
import { getDeletedMovieIds } from "@/lib/movie-edit-store";
import { getCatalogMovies } from "@/lib/movie-catalog";

type MovieSearchResult = {
  title: string;
  year: string;
  yearRange?: string;
  imdbId: string;
  kind: "movie" | "series";
  posterUrl: string;
  runtime?: string;
  genre?: string;
  rating?: string;
  imdbRating?: string;
  plot?: string;
  source: "OMDb" | "Seed";
  totalSeasons?: number;
  totalEpisodes?: number;
};

type OmdbSearchItem = {
  Title: string;
  Year: string;
  imdbID: string;
  Poster: string;
  Type: string;
};

type OmdbDetails = {
  Title: string;
  Year: string;
  imdbID: string;
  Poster: string;
  Runtime?: string;
  Genre?: string;
  Rated?: string;
  imdbRating?: string;
  Plot?: string;
  Type?: string;
  totalSeasons?: string;
  Response: "True" | "False";
};

type OmdbSearchPayload = {
  Search?: OmdbSearchItem[];
  Response: "True" | "False";
  Error?: string;
};

function posterOrFallback(poster: string | undefined) {
  return poster && poster !== "N/A" ? poster : "";
}

/**
 * Sequels are titled inconsistently across IMDb ("Evil Dead II" vs "Evil Dead 2"),
 * so fold roman numerals to digits before comparing. Single letters are left alone —
 * "V for Vendetta" and "X" are titles, not sequel numbers.
 */
const ROMAN_NUMERALS: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9",
  xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

function foldRomanNumerals(value: string) {
  return value.replace(/\b[ivx]{2,}\b/g, (token) => ROMAN_NUMERALS[token] ?? token);
}

function normalizeSearchTerm(value: string) {
  return foldRomanNumerals(value.trim().replace(/\s+/g, " ").toLowerCase());
}

const ARABIC_TO_ROMAN: Record<string, string> = Object.fromEntries(
  Object.entries(ROMAN_NUMERALS).map(([roman, arabic]) => [arabic, roman]),
);

/**
 * OMDb's `s=` endpoint matches titles literally, so "Evil Dead 2" never returns
 * tt0092991 ("Evil Dead II"). Return the numeral-swapped spelling so we can search
 * both and merge, rather than leaving the real title out of the candidate pool.
 */
function buildNumeralVariantQuery(query: string): string | undefined {
  const variant = query.replace(
    /\b(\d{1,2})\b/g,
    (token) => ARABIC_TO_ROMAN[token] ?? token,
  );
  return variant === query ? undefined : variant;
}

function readSeriesYearRange(snapshot: Record<string, unknown> | undefined): string | undefined {
  const raw =
    typeof snapshot?.Year === "string"
      ? snapshot.Year
      : typeof snapshot?.year === "string"
        ? snapshot.year
        : "";
  const cleaned = raw.trim();
  if (!cleaned) return undefined;
  return cleaned.replace("-", "–");
}

function readSeriesTotalSeasons(snapshot: Record<string, unknown> | undefined): number | undefined {
  const raw = snapshot?.totalSeasons ?? snapshot?.TotalSeasons;
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}

function readSeriesTotalEpisodes(snapshot: Record<string, unknown> | undefined): number | undefined {
  const raw = snapshot?.totalEpisodes ?? snapshot?.TotalEpisodes ?? snapshot?.episodeCount;
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}

function searchSeedCatalog(
  query: string,
  deletedMovieIds: Set<string>,
  catalogMovies: Movie[],
): MovieSearchResult[] {
  const normalizedQuery = normalizeSearchTerm(query);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);

  const scored = catalogMovies
    .filter((movie) => !deletedMovieIds.has(movie.id))
    .map((movie) => {
      const score = scoreTitleByQuery(movie.title, query);
      // Also match on IMDb ID
      const imdbMatch = movie.externalIds.imdb.toLowerCase().includes(normalizedQuery) ? 10 : 0;
      return { movie, score: score + imdbMatch };
    })
    .filter(({ score, movie }) => {
      if (score > 0) return true;
      // Fallback: any query token appears anywhere in title/year/imdbId
      const label = normalizeSearchTerm(
        `${movie.title} ${movie.releaseYear} ${movie.externalIds.imdb}`,
      );
      return queryTokens.some((t) => label.includes(t));
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return scored.map(({ movie }) => {
      const syncSnapshot = movie.metadata.syncSnapshot as Record<string, unknown> | undefined;
      const typeRaw =
        typeof syncSnapshot?.Type === "string"
          ? syncSnapshot.Type.trim().toLowerCase()
          : "";
      const kind = typeRaw === "series" ? "series" : "movie";
      return {
        title: movie.title,
        year: String(movie.releaseYear),
        yearRange: kind === "series" ? readSeriesYearRange(syncSnapshot) : undefined,
        imdbId: movie.externalIds.imdb,
        kind,
        posterUrl: movie.posterUrl,
        runtime: kind === "movie" ? `${movie.runtimeMinutes} min` : undefined,
        genre: movie.genres.join(", "),
        rating: movie.metadata.rating,
        imdbRating: movie.metadata.imdbRating || undefined,
        plot: movie.summary,
        source: "Seed",
        totalSeasons: kind === "series" ? readSeriesTotalSeasons(syncSnapshot) : undefined,
        totalEpisodes: kind === "series" ? readSeriesTotalEpisodes(syncSnapshot) : undefined,
      };
    });
}

async function fetchOmdbDetails(imdbId: string, apiKey: string) {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", imdbId);
  url.searchParams.set("plot", "short");

  const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 } });

  if (!response.ok) {
    return undefined;
  }

  const details = (await response.json()) as OmdbDetails;

  if (details.Response !== "True") {
    return undefined;
  }

  return details;
}

async function fetchOmdbSearch(query: string, apiKey: string, page = 1) {
  const searchUrl = new URL("https://www.omdbapi.com/");
  searchUrl.searchParams.set("apikey", apiKey);
  searchUrl.searchParams.set("s", query);
  if (page > 1) searchUrl.searchParams.set("page", String(page));

  const response = await fetch(searchUrl, { next: { revalidate: 60 * 60 } });
  if (!response.ok) return undefined;
  return (await response.json()) as OmdbSearchPayload;
}

function scoreTitleByQuery(title: string, query: string): number {
  const normalizedTitle = normalizeSearchTerm(title);
  const normalizedQuery = normalizeSearchTerm(query);

  // Exact match
  if (normalizedTitle === normalizedQuery) return 100;

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const titleTokens = normalizedTitle.split(" ").filter(Boolean);
  let score = 0;

  for (const queryToken of queryTokens) {
    if (titleTokens.some((token) => token === queryToken)) {
      score += 4;
    } else if (titleTokens.some((token) => token.startsWith(queryToken))) {
      score += 3;
    } else if (normalizedTitle.includes(queryToken)) {
      score += 1;
    }
  }

  // Penalise titles with many extra words beyond the query (reduces noise)
  const extraWords = Math.max(0, titleTokens.length - queryTokens.length);
  score -= extraWords * 0.5;

  return score;
}

/** OMDb `s=` often misses prefix/typo queries (e.g. "Ratato") — try shorter strings in order. */
const MAX_OMDB_SEARCH_ATTEMPTS = 14;

function buildOmdbSearchCandidates(normalizedQuery: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().replace(/\s+/g, " ");
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  add(normalizedQuery);

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length > 1) {
    for (let i = tokens.length - 1; i >= 1; i--) {
      add(tokens.slice(0, i).join(" "));
    }
  }

  for (let len = normalizedQuery.length - 1; len >= 2; len--) {
    add(normalizedQuery.slice(0, len));
  }

  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawQuery = searchParams.get("q") ?? "";
  const query = rawQuery.trim();
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const normalizedQuery = query.replace(/\s+/g, " ");
  const apiKey = process.env.OMDB_API_KEY;
  const deletedMovieIds = await getDeletedMovieIds();
  const catalogMovies = await getCatalogMovies();
  const deletedImdbIds = new Set(
    catalogMovies
      .filter((movie) => deletedMovieIds.has(movie.id))
      .map((movie) => movie.externalIds.imdb.toLowerCase()),
  );

  if (query.length < 2) {
    return NextResponse.json({ configured: Boolean(apiKey), results: [] });
  }

  if (!apiKey) {
    return NextResponse.json({
      configured: false,
      results: searchSeedCatalog(query, deletedMovieIds, catalogMovies),
    });
  }

  const candidates = buildOmdbSearchCandidates(normalizedQuery);
  let searchItems: OmdbSearchItem[] | undefined;
  let searchError: string | undefined;
  let gotNetworkResponse = false;

  for (let i = 0; i < candidates.length && i < MAX_OMDB_SEARCH_ATTEMPTS; i++) {
    const payload = await fetchOmdbSearch(candidates[i]!, apiKey, page);
    if (!payload) continue;
    gotNetworkResponse = true;
    searchError = payload.Error ?? searchError;
    if (payload.Response === "True" && payload.Search?.length) {
      searchItems = payload.Search.slice();
      searchError = undefined;
      break;
    }
  }

  if (!gotNetworkResponse) {
    return NextResponse.json(
      { configured: true, error: "Movie search failed.", results: [] },
      { status: 502 },
    );
  }

  // OMDb returns up to 10 per page; if we got a full page there are likely more.
  // Read this before merging variant results, which would inflate the count.
  const hasMore = searchItems?.length === 10;

  // Merge in the numeral-swapped spelling ("Evil Dead 2" → "Evil Dead II"). OMDb's
  // literal title match means one spelling can miss the real title entirely.
  const numeralVariant = buildNumeralVariantQuery(normalizedQuery);
  if (searchItems && numeralVariant) {
    const variantPayload = await fetchOmdbSearch(numeralVariant, apiKey, page);
    if (variantPayload?.Response === "True" && variantPayload.Search?.length) {
      const seen = new Set(searchItems.map((item) => item.imdbID.toLowerCase()));
      for (const item of variantPayload.Search) {
        if (seen.has(item.imdbID.toLowerCase())) continue;
        seen.add(item.imdbID.toLowerCase());
        searchItems.push(item);
      }
    }
  }

  // Boost results that are already in our catalog — they're more relevant to sighting submitters
  if (searchItems) {
    const catalogImdbIds = new Set(
      catalogMovies
        .filter((m) => !deletedMovieIds.has(m.id))
        .map((m) => m.externalIds.imdb.toLowerCase()),
    );
    searchItems = searchItems
      .map((item) => ({
        item,
        score:
          scoreTitleByQuery(item.Title, normalizedQuery) +
          (catalogImdbIds.has(item.imdbID.toLowerCase()) ? 20 : 0) +
          // IMDb carries stub entries for unreleased/abandoned projects that share a
          // title with the real film but have no poster, cast or credits. Submitters
          // can't tell them apart, so sink them below real records.
          (posterOrFallback(item.Poster) ? 0 : -12),
      }))
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }

  if (!searchItems) {
    const fallbackResults = searchSeedCatalog(
      normalizedQuery,
      deletedMovieIds,
      catalogMovies,
    );
    if (fallbackResults.length > 0) {
      return NextResponse.json({
        configured: true,
        error: searchError,
        results: fallbackResults,
      });
    }

    return NextResponse.json({
      configured: true,
      error: searchError ?? "No titles found.",
      results: [],
    });
  }

  const filteredItems = searchItems.filter((item) => {
    if (deletedImdbIds.has(item.imdbID.toLowerCase())) return false;
    return item.Type === "movie" || item.Type === "series";
  });
  const visibleItems = filteredItems.slice(0, 10);
  const details = await Promise.all(
    visibleItems.map((item) => fetchOmdbDetails(item.imdbID, apiKey)),
  );

  const results: MovieSearchResult[] = visibleItems.map(
    (item, index) => {
      const itemDetails = details[index];

      return {
        title: itemDetails?.Title ?? item.Title,
        year: itemDetails?.Year ?? item.Year,
        yearRange:
          (itemDetails?.Type ?? item.Type)?.toLowerCase() === "series"
            ? (itemDetails?.Year ?? item.Year).replace("-", "–")
            : undefined,
        imdbId: itemDetails?.imdbID ?? item.imdbID,
        kind:
          (itemDetails?.Type ?? item.Type)?.toLowerCase() === "series"
            ? "series"
            : "movie",
        posterUrl: posterOrFallback(itemDetails?.Poster ?? item.Poster),
        runtime: itemDetails?.Runtime,
        genre: itemDetails?.Genre,
        rating: itemDetails?.Rated,
        imdbRating:
          itemDetails?.imdbRating && itemDetails.imdbRating !== "N/A"
            ? itemDetails.imdbRating
            : undefined,
        plot: itemDetails?.Plot,
        source: "OMDb",
        totalSeasons: Number.parseInt(itemDetails?.totalSeasons ?? "", 10) || undefined,
        totalEpisodes: undefined,
      };
    },
  );

  return NextResponse.json({ configured: true, results, hasMore, page });
}
