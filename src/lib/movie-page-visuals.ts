import { upsizeAmazonPosterUrl } from "@/lib/amazon-poster-url";
import type { Movie } from "@/lib/whererat";
import {
  buildPaletteFromAccent,
  deriveDarkMoviePagePalette,
  extractMoviePagePalette,
  type MoviePagePalette,
} from "@/lib/movie-page-palette";
import { getTmdbBackdropUrl } from "@/lib/tmdb-banner";

export type MoviePageVisuals = {
  bannerUrl: string;
  /** True when sourced from TMDB widescreen backdrop (not cropped poster art) */
  bannerIsWidescreen: boolean;
  palette: MoviePagePalette | null;
  paletteDark: MoviePagePalette | null;
  /** Synced/default banner before any manual override is applied. */
  syncedBannerUrl: string;
  syncedBannerIsWidescreen: boolean;
  syncedPalette: MoviePagePalette | null;
  syncedPaletteDark: MoviePagePalette | null;
  usingManualPalette: boolean;
  usingManualPaletteDark: boolean;
  usingOverrideAccent: boolean;
};

function parseManualPalette(movie: Movie): { palette: MoviePagePalette | null; usingOverrideAccent: boolean } {
  // Check overrideAccent first
  const overrideAccent = typeof movie.metadata.overrideAccent === "string" ? movie.metadata.overrideAccent : undefined;
  if (overrideAccent) {
    const palette = buildPaletteFromAccent(overrideAccent);
    if (palette) return { palette, usingOverrideAccent: true };
  }
  // Fall back to pagePalette
  const raw = movie.metadata.pagePalette;
  return { palette: parsePaletteObject(raw), usingOverrideAccent: false };
}

function parseManualDarkPalette(movie: Movie): MoviePagePalette | null {
  const raw = movie.metadata.pagePaletteDark;
  return parsePaletteObject(raw);
}

function parsePaletteObject(raw: unknown): MoviePagePalette | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const hex = /^#?[0-9a-fA-F]{6}$/;
  const normalize = (v: unknown): string | null => {
    if (typeof v !== "string" || !hex.test(v.trim())) return null;
    const t = v.trim();
    return t.startsWith("#") ? t.toLowerCase() : `#${t.toLowerCase()}`;
  };
  const wash = normalize(obj.wash);
  const columnWash = normalize(obj.columnWash);
  const accent = normalize(obj.accent);
  const heroBloom = normalize(obj.heroBloom);
  if (!wash || !columnWash || !accent || !heroBloom) return null;
  return { wash, columnWash, accent, heroBloom };
}

export async function getSyncedMoviePageVisuals(movie: Movie, { forceRefresh }: { forceRefresh?: boolean } = {}): Promise<{
  bannerUrl: string;
  bannerIsWidescreen: boolean;
  palette: MoviePagePalette | null;
  paletteDark: MoviePagePalette | null;
}> {
  const enlargedPoster = upsizeAmazonPosterUrl(movie.posterUrl);
  const tmdbBackdrop = await getTmdbBackdropUrl({
    tmdbId: movie.externalIds.tmdb,
    imdbId: movie.externalIds.imdb,
    forceRefresh,
  });
  const posterCandidate = enlargedPoster || movie.posterUrl;
  const movieTitlePlaceholder = `https://placehold.co/1200x600/292524/fef3c7/png?text=${encodeURIComponent(movie.title)}`;

  const bannerUrl =
    tmdbBackdrop ||
    posterCandidate ||
    movieTitlePlaceholder;
  const bannerIsWidescreen = Boolean(tmdbBackdrop);

  // Use palette cached during last sync if available (avoids per-request sharp processing)
  const cachedPalette = !forceRefresh ? parsePaletteObject(movie.metadata.syncedPalette) : null;
  const cachedPaletteDark = cachedPalette
    ? (parsePaletteObject(movie.metadata.syncedPaletteDark) ?? deriveDarkMoviePagePalette(cachedPalette))
    : null;
  if (cachedPalette) {
    return { bannerUrl, bannerIsWidescreen, palette: cachedPalette, paletteDark: cachedPaletteDark };
  }

  // Try each distinct source once, in order: the banner often IS the poster, and a failed
  // fetch can cost up to 14 s, so never retry the same URL.
  let palette: MoviePagePalette | null = null;
  for (const url of new Set([bannerUrl, posterCandidate, movie.posterUrl].filter(Boolean))) {
    palette = await extractMoviePagePalette(url);
    if (palette) break;
  }
  const paletteDark = palette ? deriveDarkMoviePagePalette(palette) : null;

  return { bannerUrl, bannerIsWidescreen, palette, paletteDark };
}

export async function getMoviePageVisuals(movie: Movie): Promise<MoviePageVisuals> {
  const synced = await getSyncedMoviePageVisuals(movie);
  const { palette: manualPalette, usingOverrideAccent } = parseManualPalette(movie);
  const manualPaletteDark = parseManualDarkPalette(movie);

  // Use the stored synced banner URL if available, to avoid re-fetching potentially cached wrong TMDB image.
  const storedBannerUrl = typeof movie.metadata.syncedHeaderBannerUrl === "string" && movie.metadata.syncedHeaderBannerUrl
    ? movie.metadata.syncedHeaderBannerUrl
    : null;
  const bannerUrl = storedBannerUrl ?? synced.bannerUrl;
  const bannerIsWidescreen = storedBannerUrl ? true : synced.bannerIsWidescreen;

  return {
    bannerUrl,
    bannerIsWidescreen,
    palette: manualPalette ?? synced.palette,
    paletteDark: manualPaletteDark ?? synced.paletteDark,
    syncedBannerUrl: synced.bannerUrl,
    syncedBannerIsWidescreen: synced.bannerIsWidescreen,
    syncedPalette: synced.palette,
    syncedPaletteDark: synced.paletteDark,
    usingManualPalette: Boolean(manualPalette),
    usingManualPaletteDark: Boolean(manualPaletteDark),
    usingOverrideAccent,
  };
}
