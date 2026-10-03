import { Fragment, type CSSProperties, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getMoviePageVisuals } from "@/lib/movie-page-visuals";
import { getMergedSightingsForMovie } from "@/lib/moderation-store";
import { MODERATOR_SESSION_COOKIE, parseModeratorSession } from "@/lib/auth";
import { applyMovieOverride, getDeletedMovieIds, getMovieOverride } from "@/lib/movie-edit-store";
import { MovieSightingsCards } from "@/components/movie/movie-sightings-cards";
import { MovieTabsShell } from "@/components/movie/movie-tabs-shell";
import { MovieRatviewsTab } from "@/components/movie/movie-ratviews-tab";
import { MovieRatlatedTab } from "@/components/movie/movie-ratlated-tab";
import { MovieRatMediaTab } from "@/components/movie/movie-rat-media-tab";
import { tabCardClass, tabHeaderBorderClass } from "@/lib/movie-tab-classes";
import { MovieSightingsPagingBar, MovieSightingsSortControl } from "@/components/movie/movie-sightings-toolbar";
import { ConfirmSubmitButton } from "@/components/forms/confirm-submit-button";
import { AccentColorField } from "@/components/forms/accent-color-field";
import { ResyncButton, ResyncMenuButton } from "@/components/forms/resync-button";
import { PageHeader } from "@/components/layout/page-header";
import type { Action } from "@/components/ui/action-menu-row";
import { EditSightingForm } from "@/components/movie/edit-sighting-form";
import {
  deleteMovie,
  deleteSighting,
  resyncMovieFromImdb,
  updateMovieInfo,
  updateSightingInfo,
} from "./actions";
import {
  buildMovieSightingsPath,
  estimateRatsForAppearance,
  formatRuntimeMinutes,
  getImdbNameSearchUrl,
  getImdbTitleUrl,
  getMoviePath,
  parseMovieSightingsPageParam,
  parseMovieSightingsSortParam,
  prepareMovieSightingsView,
  getMovieSightingsSortOptions,
  splitImdbCreditSegments,
  rodentSwarmNoun,
  rodentSwarmNounPlural,
  type Movie,
} from "@/lib/whererat";
import { getCatalogMovieBySlug, getCatalogMovies } from "@/lib/movie-catalog";
import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const baseMovie = await getCatalogMovieBySlug(slug);
  if (!baseMovie) return {};

  const movieOverride = await getMovieOverride(baseMovie.id);
  const movie = applyMovieOverride(baseMovie, movieOverride);

  const sightings = await getMergedSightingsForMovie(movie.id);
  const count = sightings.length;
  const s = count === 1 ? "" : "s";

  const title = `${movie.title} (${movie.releaseYear}) — Rat Sightings on WhereRat`;
  const description = `See where rats appear in ${movie.title}. ${count} rat sighting${s} catalogued on WhereRat.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: movie.posterUrl, width: 300, height: 450, alt: movie.title }],
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

function parseHexColor(hex: string): [number, number, number] | null {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return [r, g, b];
}

function sRgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * sRgbToLinear(r) + 0.7152 * sRgbToLinear(g) + 0.0722 * sRgbToLinear(b);
}

function pickReadableInk(accentHex: string): string {
  const accent = parseHexColor(accentHex);
  if (!accent) return "#fff";
  // Mid-tone and darker accents stay with white ink — that includes the default
  // orange and most movie palettes. The threshold of 0.45 keeps borderline colors
  // (e.g. red, teal) on white; only genuinely light hues (mint, pale yellow, sky)
  // trip into the dark-ink branch.
  const luminance = relativeLuminance(accent);
  if (luminance < 0.45) return "#fff";
  // Light accent → a darkened version of the same hue (not pure black), so the
  // text keeps the brand association.
  const [r, g, b] = accent.map((c) => Math.round(c * 0.25)) as [number, number, number];
  return `rgb(${r} ${g} ${b})`;
}

function trimMeta(value: string | undefined): string {
  return value?.trim() ?? "";
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

// ---- Movie-page header icons + action builder ----

const TrashIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const EditIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const ExternalIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const PlusIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

function buildMovieHeader(opts: {
  slug: string;
  moviePath: string;
  movie: Movie;
  imdbTitleUrlResolved: string | null;
  canEditMovie: boolean;
  deleteMovie: (formData: FormData) => Promise<void>;
  resyncMovieFromImdb: (formData: FormData) => Promise<void>;
}): { actions: Action[]; primaryAction: { href: string; label: string; icon: ReactNode } } {
  const { slug, moviePath, movie, imdbTitleUrlResolved, canEditMovie, deleteMovie, resyncMovieFromImdb } = opts;
  // Ordered: most-used first (stays inline when overflow collapses).
  // Delete is intentionally LAST so it sits at the bottom of the dropdown.
  const actions: Action[] = [];

  if (canEditMovie) {
    actions.push({
      kind: "link",
      key: "edit",
      label: "Edit movie information",
      icon: EditIcon,
      href: `${moviePath}?editMovie=1`,
    });
    actions.push({
      kind: "custom",
      key: "resync",
      label: "Resync from IMDb",
      icon: null,
      iconNode: (
        <form action={resyncMovieFromImdb}>
          <input type="hidden" name="slug" value={slug} />
          <ResyncButton />
        </form>
      ),
      menuNode: (
        <form action={resyncMovieFromImdb} className="contents">
          <input type="hidden" name="slug" value={slug} />
          <ResyncMenuButton />
        </form>
      ),
    });
  }

  if (imdbTitleUrlResolved) {
    actions.push({
      kind: "link",
      key: "imdb",
      label: "Open on IMDb",
      icon: ExternalIcon,
      href: imdbTitleUrlResolved,
      external: true,
    });
  }

  if (canEditMovie) {
    // Destructive action — bottom of the flyout, danger styling.
    actions.push({
      kind: "confirm-form",
      key: "delete",
      label: "Delete movie",
      icon: TrashIcon,
      formAction: deleteMovie,
      hidden: { slug },
      confirmMessage: "Delete this movie? This cannot be undone.",
      danger: true,
    });
  }

  const primaryAction = {
    href: `/submit?for=${encodeURIComponent(movie.externalIds.imdb)}&title=${encodeURIComponent(movie.title)}&year=${encodeURIComponent(String(movie.releaseYear))}&poster=${encodeURIComponent(movie.posterUrl)}`,
    label: "Submit a Sighting",
    icon: PlusIcon,
  };

  return { actions, primaryAction };
}

function movieHeroMetaLine(movie: Movie, isSeriesTitle: boolean): string | null {
  const parts: string[] = [];
  const syncSnapshot = movie.metadata.syncSnapshot as Record<string, unknown> | undefined;

  if (isSeriesTitle) {
    const yearRange = readSeriesYearRange(syncSnapshot) ?? String(movie.releaseYear);
    parts.push(yearRange);
    const totalSeasons = readSeriesTotalSeasons(syncSnapshot);
    const totalEpisodes = readSeriesTotalEpisodes(syncSnapshot);
    if (totalSeasons) {
      parts.push(`${totalSeasons} ${totalSeasons === 1 ? "season" : "seasons"}`);
    }
    if (totalEpisodes) {
      parts.push(`${totalEpisodes} ${totalEpisodes === 1 ? "episode" : "episodes"}`);
    }
  } else {
    if (Number.isFinite(movie.releaseYear) && movie.releaseYear > 0) {
      parts.push(String(movie.releaseYear));
    }
    if (Number.isFinite(movie.runtimeMinutes) && movie.runtimeMinutes > 0) {
      parts.push(`${movie.runtimeMinutes} min`);
    }
  }
  const rating = trimMeta(movie.metadata.rating);
  if (rating) parts.push(rating);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}


function ImdbCreditsInline({ line }: { line: string }) {
  const segments = splitImdbCreditSegments(line);

  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          {index > 0 ? ", " : null}
          <a
            href={getImdbNameSearchUrl(segment)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-stone-900 underline decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_40%,rgb(120_113_108/0.8))] decoration-1 underline-offset-[3px] transition hover:text-stone-950 hover:decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_78%,#000)] dark:text-stone-100 dark:decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_52%,rgb(245_240_232/0.65))] dark:hover:text-stone-50 dark:hover:decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_72%,rgb(245_240_232))]"
          >
            {segment}
          </a>
        </Fragment>
      ))}
    </>
  );
}

/** Sample pixels with sharp (Node). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const RODENT_HIGHLIGHT_RE =
  /\b(rats?|ratty|rat-like|ratcatcher|mice|mouse|rodents?|gerbils?|hamsters?|squirrels?|voles?|beavers?|marmots?|guinea\s+pigs?|murine|vermin)\b/gi;

function highlightRodentWords(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  RODENT_HIGHLIGHT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RODENT_HIGHLIGHT_RE.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <mark
        key={match.index}
        className="rounded-sm bg-amber-200/70 px-0.5 text-amber-950 not-italic dark:bg-amber-500/30 dark:text-amber-200"
      >
        {match[0]}
      </mark>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

export async function generateStaticParams() {
  try {
    const allMovies = await getCatalogMovies();
    return allMovies.map((movie) => ({ slug: movie.slug }));
  } catch {
    // No DB available (e.g. CI build without DATABASE_URL) — skip pre-generation;
    // all slugs will be served dynamically at request time.
    return [];
  }
}

export async function MoviePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: SearchParams;
}) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const baseMovie = await getCatalogMovieBySlug(slug);

  if (!baseMovie) {
    notFound();
  }
  const deletedMovieIds = await getDeletedMovieIds();
  if (deletedMovieIds.has(baseMovie.id)) {
    notFound();
  }
  const movieOverride = await getMovieOverride(baseMovie.id);
  const movie = applyMovieOverride(baseMovie, movieOverride);
  const moviePath = getMoviePath(movie);
  const editMovie = single(query.editMovie) === "1";
  const editSightingId = single(query.editSighting)?.trim() ?? "";
  const cookieStore = await cookies();
  const moderatorSession = parseModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );
  const canEditMovie = moderatorSession?.role === "owner";
  const canEditSightings = Boolean(moderatorSession);

  const sort = parseMovieSightingsSortParam(single(query.sort));
  const page = parseMovieSightingsPageParam(single(query.page));

  const movieSightings = await getMergedSightingsForMovie(movie.id);
  const isSeriesTitle = movieSightings.some((sighting) => sighting.imdbKind === "series");
  const allRodentTypes = [...new Set(movieSightings.flatMap((s) => s.rodentTypes ?? ["rat"]))];
  const rodentNoun = rodentSwarmNoun(allRodentTypes);
  const rodentNounPlural = rodentSwarmNounPlural(allRodentTypes);
  const allowedSorts = getMovieSightingsSortOptions(isSeriesTitle);
  const safeSort = allowedSorts.includes(sort) ? sort : "newest";
  const movieSpoilerCount = movieSightings.filter((s) => s.spoiler).length;
  const approxRatsInMovie = movieSightings.reduce(
    (sum, s) => sum + estimateRatsForAppearance(s),
    0,
  );
  const sightingsView = prepareMovieSightingsView({
    items: movieSightings,
    sort: safeSort,
    page,
    runtimeMinutes: movie.runtimeMinutes,
  });

  if (page !== sightingsView.safePage || safeSort !== sort) {
    redirect(
      buildMovieSightingsPath(moviePath, {
        sort: safeSort,
        page: sightingsView.safePage,
      }),
    );
  }

  const { pageSlice } = sightingsView;
  const sightingsBasePath = buildMovieSightingsPath(moviePath, {
    sort: safeSort,
    page: sightingsView.safePage,
  });
  const editingSighting = editSightingId
    ? movieSightings.find((item) => item.id === editSightingId)
    : undefined;
  const visuals = await getMoviePageVisuals(movie);
  const palette = visuals.palette;
  const heroMetaLine = movieHeroMetaLine(movie, isSeriesTitle);
  const manualPaletteDark = movie.metadata.pagePaletteDark;
  const darkPalette = manualPaletteDark ?? visuals.paletteDark;

  const rootStyle: CSSProperties | undefined = palette
    ? ({
      "--movie-wash": palette.wash,
      "--movie-column-wash": palette.columnWash,
      "--movie-accent": palette.accent,
      "--movie-accent-ink": pickReadableInk(palette.accent),
      "--movie-hero-bloom": palette.heroBloom,
      "--movie-wash-dark": darkPalette?.wash ?? palette.wash,
      "--movie-column-wash-dark": darkPalette?.columnWash ?? palette.columnWash,
      "--movie-accent-dark": darkPalette?.accent ?? palette.accent,
      "--movie-accent-ink-dark": pickReadableInk(darkPalette?.accent ?? palette.accent),
      "--movie-hero-bloom-dark":
        darkPalette?.heroBloom ?? palette.heroBloom,
    } as CSSProperties)
    : undefined;

  // Sidebar label classes — mix accent colour in on palette pages for better readability
  const sidebarSectionTitleClass = palette
    ? "text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[color-mix(in_srgb,var(--movie-accent)_55%,rgb(120_113_108))] dark:text-[color-mix(in_srgb,var(--movie-accent)_45%,rgb(168_162_158))]"
    : "text-[0.7rem] font-bold uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500";
  const sidebarDtClass = palette
    ? "text-xs font-medium text-[color-mix(in_srgb,var(--movie-accent)_40%,rgb(120_113_108))] dark:text-[color-mix(in_srgb,var(--movie-accent)_35%,rgb(161_155_150))]"
    : "text-xs font-medium text-stone-500 dark:text-stone-400";

  const director = trimMeta(movie.metadata.director);
  const originalLanguage = trimMeta(movie.metadata.originalLanguage);
  const countriesLine = movie.metadata.productionCountries
    .map((c) => c.trim())
    .filter(Boolean)
    .join(", ");
  const runtimeLabel = formatRuntimeMinutes(movie.runtimeMinutes);
  const certificate = trimMeta(movie.metadata.rating);
  const writers = trimMeta(movie.metadata.writers);
  const cast = trimMeta(movie.metadata.cast);
  const awards = trimMeta(movie.metadata.awards);
  const ratFacts = (movie.metadata.ratFacts ?? []).filter((f) => f.trim());
  const imdbReviews = movie.metadata.imdbReviews ?? [];
  const imdbRelated = movie.metadata.imdbRelated ?? [];
  const imdbVideos = movie.metadata.imdbVideos ?? [];
  const imdbImages = movie.metadata.imdbImages ?? [];
  const youtubeTrailerKey = typeof movie.metadata.youtubeTrailerKey === "string" ? movie.metadata.youtubeTrailerKey : undefined;
  const imdbRating = trimMeta(movie.metadata.imdbRating);
  const imdbVotes = trimMeta(movie.metadata.imdbVotes);
  const metascore = trimMeta(movie.metadata.metascore);
  const imdbTitleUrlResolved = getImdbTitleUrl(movie.externalIds.imdb);
  const hasDetailsSection = Boolean(
    runtimeLabel ||
    certificate ||
    imdbRating ||
    metascore ||
    writers ||
    director ||
    cast ||
    originalLanguage ||
    countriesLine ||
    awards,
  );

  return (
    <>
      {palette && (
        <style dangerouslySetInnerHTML={{
          __html: [
            `:root { --wr-header-bg: color-mix(in srgb, ${palette.accent} 24%, rgb(255 248 237 / 0.92)) !important; --wr-surface-cream: color-mix(in srgb, ${palette.accent} 22%, #fff8ed) !important; --wr-surface-cream-soft: color-mix(in srgb, ${palette.accent} 16%, #fffdf8) !important; --wr-surface-cream-muted: color-mix(in srgb, ${palette.accent} 18%, #faf7f2) !important; --wr-accent-btn: ${palette.accent} !important; --wr-accent-btn-hover: color-mix(in srgb, ${palette.accent} 88%, #000) !important; --movie-accent-ink: ${pickReadableInk(palette.accent)} !important; --wr-btn-ghost-bg: color-mix(in srgb, ${palette.accent} 8%, rgb(255 255 255 / 0.94)) !important; --wr-btn-ghost-border: color-mix(in srgb, ${palette.accent} 28%, rgb(87 83 78 / 0.58)) !important; --wr-btn-ghost-hover: color-mix(in srgb, ${palette.accent} 13%, rgb(245 245 244)) !important; --wr-btn-ghost-active: color-mix(in srgb, ${palette.accent} 17%, rgb(231 229 228)) !important; --wr-input-bg: color-mix(in srgb, ${palette.accent} 6%, rgb(255 253 249)) !important; --wr-input-border: color-mix(in srgb, ${palette.accent} 20%, rgb(28 25 23 / 0.22)) !important; --wr-input-border-focus: ${palette.accent} !important; --wr-shadow-input-focus: color-mix(in srgb, ${palette.accent} 40%, transparent) !important; --wr-footer-bg: color-mix(in srgb, ${palette.accent} 24%, #fff8ed) !important; --wr-brand-wordmark: color-mix(in srgb, ${palette.accent} 50%, #57534e) !important; }`,
            `.dark { --wr-header-bg: color-mix(in srgb, ${palette.accent} 12%, rgb(41 37 36 / 0.94)) !important; --wr-accent-btn: color-mix(in srgb, ${palette.accent} 82%, white) !important; --wr-accent-btn-hover: color-mix(in srgb, ${palette.accent} 90%, white) !important; --movie-accent-ink-dark: ${pickReadableInk(darkPalette?.accent ?? palette.accent)} !important; --wr-btn-ghost-bg: color-mix(in srgb, ${palette.accent} 14%, rgb(68 64 60 / 0.88)) !important; --wr-btn-ghost-border: color-mix(in srgb, ${palette.accent} 26%, rgb(214 211 209 / 0.24)) !important; --wr-btn-ghost-hover: color-mix(in srgb, ${palette.accent} 20%, rgb(53 46 41)) !important; --wr-btn-ghost-active: color-mix(in srgb, ${palette.accent} 24%, rgb(63 54 46)) !important; --wr-input-bg: color-mix(in srgb, ${palette.accent} 14%, rgb(22 16 10)) !important; --wr-input-border: color-mix(in srgb, ${palette.accent} 18%, rgb(254 243 199 / 0.16)) !important; --wr-input-border-focus: color-mix(in srgb, ${palette.accent} 82%, white) !important; --wr-shadow-input-focus: color-mix(in srgb, ${palette.accent} 35%, transparent) !important; --wr-footer-bg: color-mix(in srgb, ${palette.accent} 10%, #292524) !important; --wr-brand-wordmark: color-mix(in srgb, ${palette.accent} 45%, #fef3c7) !important; }`,
            `.wr-shell { background: color-mix(in srgb, ${palette.accent} 24%, var(--background)) !important; }`,
          ].join(' ')
        }} />
      )}
      <main
        style={rootStyle}
        className="wr-page-shell py-8 sm:py-10"
      >
        {(() => {
          const { actions: headerActions, primaryAction: headerPrimary } = buildMovieHeader({
            slug,
            moviePath,
            movie,
            imdbTitleUrlResolved,
            canEditMovie,
            deleteMovie,
            resyncMovieFromImdb,
          });
          return (
            <PageHeader
              back={{ href: "/#catalog", label: "Catalog" }}
              actions={headerActions}
              primaryAction={headerPrimary}
              themed={Boolean(palette)}
              className="mb-0"
            />
          );
        })()}

        <section
          className={`wr-cheese-panel mt-6 overflow-hidden ${palette ? "movie-page-palette-bg" : "wr-cheese-tile-cream"}`}
        >
          <div className="relative min-h-[min(22rem,70vw)] overflow-hidden border-b-2 border-stone-950/22 dark:border-white/20 sm:min-h-80">
            <Image
              src={visuals.bannerUrl}
              alt={
                visuals.bannerIsWidescreen
                  ? `${movie.title} theatrical backdrop (TMDB)`
                  : `${movie.title} poster artwork (wide header crop)`
              }
              width={1280}
              height={720}
              className="absolute inset-0 h-full w-full object-cover object-[center_28%]"
              priority
              sizes="100vw"
            />
            {palette ? (
              <div
                aria-hidden
                className="absolute inset-0"
                style={{
                  backgroundImage: `
                  radial-gradient(ellipse 100% 90% at 15% -5%, color-mix(in srgb, var(--movie-hero-bloom) 38%, transparent) 0%, transparent 55%),
                  linear-gradient(to top, rgb(12 10 9 / 0.9) 0%, rgb(12 10 9 / 0.58) 40%, rgb(12 10 9 / 0.15) 100%)`,
                }}
              />
            ) : (
              <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/75 to-stone-950/25" />
            )}
            <div className="relative flex min-h-[min(22rem,70vw)] flex-col justify-end p-6 pb-6 sm:min-h-80 sm:pb-24 lg:p-10 lg:pb-24">
              <div className="flex max-w-3xl flex-col gap-6">
                <div className="flex flex-col gap-2 sm:gap-3">
                  <h1
                    className={`wr-display max-w-3xl text-[clamp(1.5rem,5.5vw,2.25rem)] font-bold leading-[1.05] tracking-tight sm:text-4xl sm:leading-[1.04] lg:text-5xl lg:leading-[1.03] ${palette
                      ? "text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_5%,rgb(255_253_249))]"
                      : "text-amber-50"
                      }`}
                  >
                    {movie.title}
                  </h1>
                  {heroMetaLine ? (
                    <p
                      className={`text-sm font-semibold ${palette
                        ? "text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_35%,rgb(254_246_229_/_0.92))]"
                        : "text-amber-200/90"
                        }`}
                    >
                      {heroMetaLine}
                    </p>
                  ) : null}
                </div>
                {trimMeta(movie.metadata.tagline) ? (
                  <p
                    className={`max-w-2xl text-base font-medium italic leading-relaxed sm:text-lg ${palette
                      ? "text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_18%,rgb(255_251_246_/_0.96))]"
                      : "text-amber-100/95"
                      }`}
                  >
                    &quot;{movie.metadata.tagline.trim()}&quot;
                  </p>
                ) : null}
                {(movieSightings.length > 0 || imdbRating) ? (() => {
                  const chipWrap = `rounded-xl border px-4 py-2.5 backdrop-blur-md ${palette
                    ? "border-[color-mix(in_srgb,var(--movie-accent)_28%,transparent)] bg-[rgb(0_0_0/0.48)]"
                    : "border-white/22 bg-black/42"
                    }`;
                  const chipDt = palette
                    ? "text-[0.65rem] font-bold uppercase tracking-[0.18em] text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_38%,rgb(254_244_229_/_0.85))]"
                    : "text-[0.65rem] font-bold uppercase tracking-[0.18em] text-amber-200/78";
                  const chipDd = `wr-display mt-1 tabular-nums text-2xl font-bold leading-none tracking-tight sm:text-[1.625rem] ${palette
                    ? "text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_6%,rgb(255_252_246))]"
                    : "text-amber-50"
                    }`;
                  return (
                    <dl className="flex flex-wrap gap-3">
                      {movieSightings.length > 0 ? (
                        <div className={chipWrap}>
                          <dt className={chipDt}>Sightings</dt>
                          <dd className={chipDd}>{movieSightings.length}</dd>
                        </div>
                      ) : null}
                      {approxRatsInMovie > 0 ? (
                        <div className={chipWrap}>
                          <dt className={chipDt}>Total {rodentNounPlural}</dt>
                          <dd className={chipDd}>{approxRatsInMovie}</dd>
                        </div>
                      ) : null}
                      {imdbRating ? (
                        <div className={chipWrap}>
                          <dt className={chipDt}>IMDb</dt>
                          <dd className={`${chipDd} flex items-baseline gap-1.5`}>
                            <span className="text-amber-300">★</span>
                            {imdbRating}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  );
                })() : null}
              </div>
            </div>
          </div>

          <MovieTabsShell
            palette={Boolean(palette)}
            tabs={[
              { id: "sightings", label: `Featured ${rodentNounPlural}` },
              ...(ratFacts.length > 0 ? [{ id: "rat-facts", label: `${rodentNoun} Facts` }] : []),
              { id: "rat-views", label: "Reviews" },
              { id: "rat-media", label: "Media" },
              { id: "ratlated", label: "Related" },
            ]}
            sidebarContent={
              <>
                <Image
                  src={movie.posterUrl}
                  alt={movie.posterAlt}
                  width={480}
                  height={720}
                  className="aspect-[2/3] w-full max-w-[18rem] self-center shrink-0 rounded-xl object-cover shadow-[0_6px_28px_-4px_rgb(0_0_0/0.22)] dark:shadow-[0_6px_28px_-4px_rgb(0_0_0/0.55)] lg:max-w-full"
                />
                <section className="space-y-2.5">
                  <h2 className={sidebarSectionTitleClass}>Synopsis</h2>
                  <p className="text-sm leading-[1.65] text-stone-800 dark:text-stone-200">
                    {movie.summary}
                  </p>
                </section>
                <section className="space-y-3">
                  <h2 className={sidebarSectionTitleClass}>Genres</h2>
                  <ul className="flex flex-wrap gap-2">
                    {movie.genres.map((genre) => (
                      <li key={genre}>
                        <span
                          className={`inline-flex rounded-lg border px-2.5 py-1.5 text-xs font-semibold leading-none shadow-[1px_1px_0_0_rgb(28_25_23/0.12)] dark:shadow-[1px_1px_0_0_rgb(0_0_0/0.35)] ${palette
                            ? "border-[color-mix(in_srgb,var(--movie-accent)_45%,rgb(120_113_108))] bg-[color-mix(in_srgb,var(--movie-column-wash)_88%,white)] text-stone-900 dark:border-[color-mix(in_srgb,var(--movie-accent)_40%,rgb(245_240_232/0.25))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_16%,rgb(26_20_14))] dark:text-[color-mix(in_srgb,var(--movie-accent)_30%,rgb(245_240_232))]"
                            : "border-stone-400/65 bg-white text-stone-900 dark:border-amber-500/40 dark:bg-stone-800 dark:text-amber-100"
                            }`}
                        >
                          {genre}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
                {hasDetailsSection ? (
                  <section
                    className={`space-y-5 border-t pt-8 ${palette
                      ? "border-[color-mix(in_srgb,var(--movie-accent)_26%,rgb(120_113_108/0.7))] dark:border-[color-mix(in_srgb,var(--movie-accent)_28%,rgb(245_240_232/0.24))]"
                      : "border-stone-900/18 dark:border-white/14"
                      }`}
                  >
                    <h2 className={sidebarSectionTitleClass}>Details</h2>
                    <dl className="space-y-5 text-sm text-stone-800 dark:text-stone-100">
                      {runtimeLabel ? (
                        <div>
                          <dt className={sidebarDtClass}>Runtime</dt>
                          <dd className="mt-1 font-semibold">{runtimeLabel}</dd>
                        </div>
                      ) : null}
                      {certificate ? (
                        <div>
                          <dt className={sidebarDtClass}>Certificate</dt>
                          <dd className="mt-1 font-semibold">{certificate}</dd>
                        </div>
                      ) : null}
                      {imdbRating ? (
                        <div>
                          <dt className={sidebarDtClass}>IMDb score</dt>
                          <dd className="mt-1">
                            <a
                              href={imdbTitleUrlResolved}
                              target="_blank"
                              rel="noreferrer"
                              className={`group font-semibold text-stone-900 underline decoration-stone-400 decoration-1 underline-offset-2 ${palette
                                ? "hover:decoration-[color-mix(in_srgb,var(--movie-accent)_85%,#000)] dark:text-[color-mix(in_srgb,var(--movie-accent)_30%,rgb(245_240_232))] dark:decoration-[color-mix(in_srgb,var(--movie-accent)_40%,rgb(245_240_232/0.45))] dark:hover:decoration-[color-mix(in_srgb,var(--movie-accent)_65%,rgb(245_240_232/0.75))]"
                                : "hover:decoration-amber-600 dark:text-amber-100 dark:decoration-amber-500/55 dark:hover:decoration-amber-400"
                                }`}
                            >
                              <span className="tabular-nums text-[1.06em] tracking-tight">
                                ★ {imdbRating}
                              </span>
                              <span className="font-medium text-stone-600 dark:text-stone-300">
                                /10
                              </span>
                              {imdbVotes ? (
                                <span className="font-normal text-stone-600 dark:text-stone-400">
                                  {" "}
                                  ({imdbVotes} votes)
                                </span>
                              ) : null}
                            </a>
                          </dd>
                        </div>
                      ) : null}
                      {metascore ? (
                        <div>
                          <dt className={sidebarDtClass}>Metacritic</dt>
                          <dd className="mt-1 font-semibold tabular-nums">
                            {metascore}/100 Metascore
                          </dd>
                        </div>
                      ) : null}
                      {writers ? (
                        <div>
                          <dt className={sidebarDtClass}>Writers</dt>
                          <dd className="mt-1 leading-snug">
                            <ImdbCreditsInline line={writers} />
                          </dd>
                        </div>
                      ) : null}
                      {director ? (
                        <div>
                          <dt className={sidebarDtClass}>Director</dt>
                          <dd className="mt-1 leading-snug">
                            <ImdbCreditsInline line={director} />
                          </dd>
                        </div>
                      ) : null}
                      {cast ? (
                        <div>
                          <dt className={sidebarDtClass}>Cast (top billed)</dt>
                          <dd className="mt-1 leading-relaxed">
                            <ImdbCreditsInline line={cast} />
                          </dd>
                        </div>
                      ) : null}
                      {originalLanguage ? (
                        <div>
                          <dt className={sidebarDtClass}>Language</dt>
                          <dd className="mt-1 font-medium">{originalLanguage}</dd>
                        </div>
                      ) : null}
                      {countriesLine ? (
                        <div>
                          <dt className={sidebarDtClass}>Countries</dt>
                          <dd className="mt-1 font-medium leading-snug">
                            {countriesLine}
                          </dd>
                        </div>
                      ) : null}
                      {awards ? (
                        <div>
                          <dt className={sidebarDtClass}>Honors</dt>
                          <dd className="mt-1 text-sm italic leading-snug text-stone-600 dark:text-stone-400">
                            {awards}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </section>
                ) : null}
              </>
            }
          >
            {/* Panel 0 — On-screen Rats */}
            <div>
              <header className={`mb-6 border-b pb-4 ${tabHeaderBorderClass(Boolean(palette))}`}>
                <div className="flex min-h-12 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="wr-display shrink-0 text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-50 sm:text-3xl">
                    Featured {rodentNounPlural}
                  </h2>
                  {movieSightings.length > 0 ? (
                    <MovieSightingsSortControl
                      moviePath={moviePath}
                      sort={safeSort}
                      palette={Boolean(palette)}
                      isSeries={isSeriesTitle}
                      sortLabelRats={`Most ${rodentNounPlural.toLowerCase()} (est.)`}
                    />
                  ) : null}
                </div>
              </header>

              {movieSightings.length > 0 ? (
                <MovieSightingsPagingBar
                  moviePath={moviePath}
                  sort={safeSort}
                  safePage={sightingsView.safePage}
                  pageCount={sightingsView.pageCount}
                  totalCount={sightingsView.totalCount}
                  palette={Boolean(palette)}
                />
              ) : null}

              <div className="space-y-4">
                {movieSightings.length === 0 ? (
                  <div
                    className={`mt-6 rounded-2xl border-2 border-dashed px-6 py-14 text-center dark:border-white/18 ${palette
                      ? "border-[color-mix(in_srgb,var(--movie-accent)_25%,rgb(214_211_209))] bg-[color-mix(in_srgb,var(--movie-column-wash)_55%,white)] dark:bg-[rgb(34_29_25/0.65)]"
                      : "border-stone-900/25 bg-[var(--wr-surface-cream-soft)]/80 dark:bg-stone-900/40"
                      }`}
                  >
                    <img src="/openmoji/color/svg/1F400.svg" alt="Rat" width={48} height={48} className="mx-auto" aria-hidden />
                    <p className="wr-display mt-4 text-lg font-bold text-stone-800 dark:text-stone-100">
                      No rat sightings catalogued yet
                    </p>
                    <p className="mx-auto mt-2 max-w-sm text-sm text-stone-600 dark:text-stone-400">
                      Be the first to document a rat in this title — your sighting goes into review and gets published when approved.
                    </p>
                    <Link
                      href={`/submit?for=${encodeURIComponent(movie.externalIds.imdb)}&title=${encodeURIComponent(movie.title)}&year=${encodeURIComponent(String(movie.releaseYear))}&poster=${encodeURIComponent(movie.posterUrl)}`}
                      className="mt-6 inline-flex wr-btn-primary"
                    >
                      Submit a sighting
                    </Link>
                  </div>
                ) : null}

                {movieSightings.length > 0 ? (
                  <MovieSightingsCards
                    items={pageSlice}
                    palette={Boolean(palette)}
                    spoilerCountMovie={movieSpoilerCount}
                    canEditSightings={canEditSightings}
                    editBasePath={sightingsBasePath}
                    isSeries={isSeriesTitle}
                  />
                ) : null}
              </div>

              {movieSightings.length > 0 ? (
                <MovieSightingsPagingBar
                  moviePath={moviePath}
                  sort={safeSort}
                  safePage={sightingsView.safePage}
                  pageCount={sightingsView.pageCount}
                  totalCount={sightingsView.totalCount}
                  palette={Boolean(palette)}
                  placement="bottom"
                />
              ) : null}
            </div>

            {/* Panel 1 — Rat Facts (conditional, must match tab condition) */}
            {ratFacts.length > 0 ? (
              <div>
                <header className={`mb-6 border-b pb-4 ${tabHeaderBorderClass(Boolean(palette))}`}>
                  <div className="flex min-h-12 items-center">
                    <h2 className="wr-display text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-50 sm:text-3xl">
                      {rodentNoun} Facts
                    </h2>
                  </div>
                </header>
                <div className="space-y-3">
                  {ratFacts.map((fact, i) => (
                    <div key={i} className={`${tabCardClass(Boolean(palette))} px-5 py-4`}>
                      <p className="text-sm leading-relaxed text-stone-700 dark:text-stone-300">
                        {highlightRodentWords(fact)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Panel 2 — Reviews */}
            <MovieRatviewsTab
              reviews={imdbReviews}
              palette={Boolean(palette)}
            />

            {/* Panel 3 — Media */}
            <MovieRatMediaTab
              videos={imdbVideos}
              images={imdbImages}
              youtubeTrailerKey={youtubeTrailerKey}
              palette={Boolean(palette)}
            />

            {/* Panel 4 — Related */}
            <MovieRatlatedTab
              titles={imdbRelated}
              palette={Boolean(palette)}
            />
          </MovieTabsShell>
        </section>

        {editMovie && canEditMovie ? (
          <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 p-6">
            <div className={`flex flex-col w-full max-w-3xl overflow-hidden rounded-2xl border-2 border-stone-950/22 shadow-[0_20px_60px_rgb(0_0_0/0.45)] ${palette ? "bg-[var(--wr-surface-cream)] dark:border-[color-mix(in_srgb,var(--movie-accent)_20%,rgb(255_255_255/0.18))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_10%,rgb(24_19_15))]" : "bg-white dark:border-white/20 dark:bg-stone-900"}`} style={{ maxHeight: "min(92dvh, calc(100dvh - 3rem))" }}>
              {/* Sticky header */}
              <div className={`shrink-0 flex items-center gap-3 border-b px-5 py-4 sm:px-6 sm:py-5 ${palette ? "border-[color-mix(in_srgb,var(--movie-accent)_20%,rgb(120_113_108/0.25))] bg-[color-mix(in_srgb,var(--movie-column-wash)_14%,var(--wr-surface-cream))] dark:border-[color-mix(in_srgb,var(--movie-accent)_22%,rgb(245_240_232/0.1))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_14%,rgb(18_13_9))]" : "border-stone-900/10 dark:border-white/10"}`}>
                <h2 className="min-w-0 flex-1 truncate text-lg font-black text-stone-950 dark:text-stone-100">
                  Edit movie
                </h2>
                <Link
                  href={moviePath}
                  aria-label="Close"
                  title="Close"
                  className="wr-btn-ghost inline-flex h-9 w-9 shrink-0 items-center justify-center px-0 py-0"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="size-4" aria-hidden="true">
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                  </svg>
                </Link>
              </div>

              {/* Scrollable body */}
              <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto px-5 sm:px-6">
                {(() => {
                  const syncSnapshot = movie.metadata.syncSnapshot as Record<string, unknown> | undefined;
                  return (
                    <form id="edit-movie-form" action={updateMovieInfo} className="py-5 grid gap-4">
                      <input type="hidden" name="slug" value={slug} />
                      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Title
                        <input name="title" required defaultValue={movie.title} className="wr-input" />
                      </label>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Release year
                          <input name="releaseYear" type="number" defaultValue={movie.releaseYear} className="wr-input" />
                        </label>
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Runtime (minutes)
                          <input name="runtimeMinutes" type="number" defaultValue={movie.runtimeMinutes} className="wr-input" />
                          {(() => {
                            const syncedVal = String(syncSnapshot?.runtimeMinutes ?? "").trim();
                            const currentVal = String(movie.runtimeMinutes ?? "");
                            return syncedVal && syncedVal !== currentVal ? (
                              <span className="text-xs text-stone-400 dark:text-stone-500">Synced: {syncedVal}</span>
                            ) : null;
                          })()}
                        </label>
                      </div>
                      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Genres (comma-separated)
                        <input name="genres" defaultValue={movie.genres.join(", ")} className="wr-input" />
                      </label>
                      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Summary
                        <textarea name="summary" rows={4} defaultValue={movie.summary} className="wr-input h-auto min-h-[7rem] py-3 leading-relaxed" />
                      </label>
                      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Poster image URL
                        <input name="posterUrl" defaultValue={movie.posterUrl} className="wr-input" />
                      </label>
                      <div className="flex flex-col gap-1 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Current hero banner URL
                        <p className="break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs font-normal text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
                          {visuals.bannerUrl}
                        </p>
                        <span className="text-xs font-normal text-stone-400 dark:text-stone-500">
                          Resynced {movie.metadata.lastSyncedAt ?? "never"}
                        </span>
                      </div>
                      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Tagline
                        <input name="tagline" defaultValue={movie.metadata.tagline} className="wr-input" />
                      </label>
                      <div className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Accent color
                        <AccentColorField
                          autoAccent={visuals.syncedPalette?.accent ?? "#b45309"}
                          currentOverride={movie.metadata.overrideAccent ?? ""}
                        />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Certificate
                          <input name="rating" defaultValue={movie.metadata.rating} className="wr-input" />
                          {(() => {
                            const syncedVal = String(syncSnapshot?.rating ?? "").trim();
                            const currentVal = String(movie.metadata.rating ?? "").trim();
                            return syncedVal && syncedVal !== currentVal ? (
                              <span className="text-xs text-stone-400 dark:text-stone-500">Synced: {syncedVal}</span>
                            ) : null;
                          })()}
                        </label>
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Director
                          <input name="director" defaultValue={movie.metadata.director} className="wr-input" />
                          {(() => {
                            const syncedVal = String(syncSnapshot?.director ?? "").trim();
                            const currentVal = String(movie.metadata.director ?? "").trim();
                            return syncedVal && syncedVal !== currentVal ? (
                              <span className="text-xs text-stone-400 dark:text-stone-500">Synced: {syncedVal}</span>
                            ) : null;
                          })()}
                        </label>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Writers
                          <input name="writers" defaultValue={movie.metadata.writers} className="wr-input" />
                          {(() => {
                            const syncedVal = String(syncSnapshot?.writers ?? "").trim();
                            const currentVal = String(movie.metadata.writers ?? "").trim();
                            return syncedVal && syncedVal !== currentVal ? (
                              <span className="text-xs text-stone-400 dark:text-stone-500">Synced: {syncedVal}</span>
                            ) : null;
                          })()}
                        </label>
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Cast (top billed)
                          <input name="cast" defaultValue={movie.metadata.cast} className="wr-input" />
                          {(() => {
                            const syncedVal = String(syncSnapshot?.cast ?? "").trim();
                            const currentVal = String(movie.metadata.cast ?? "").trim();
                            return syncedVal && syncedVal !== currentVal ? (
                              <span className="text-xs text-stone-400 dark:text-stone-500">Synced: {syncedVal}</span>
                            ) : null;
                          })()}
                        </label>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          IMDb score
                          <input name="imdbRating" defaultValue={movie.metadata.imdbRating} className="wr-input" />
                          {(() => {
                            const syncedVal = String(syncSnapshot?.imdbRating ?? "").trim();
                            const currentVal = String(movie.metadata.imdbRating ?? "").trim();
                            return syncedVal && syncedVal !== currentVal ? (
                              <span className="text-xs text-stone-400 dark:text-stone-500">Synced: {syncedVal}</span>
                            ) : null;
                          })()}
                        </label>
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          IMDb votes
                          <input name="imdbVotes" defaultValue={movie.metadata.imdbVotes} className="wr-input" />
                        </label>
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Metascore
                          <input name="metascore" defaultValue={movie.metadata.metascore} className="wr-input" />
                        </label>
                      </div>
                      <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Awards / honors
                        <input name="awards" defaultValue={movie.metadata.awards} className="wr-input" />
                      </label>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Language
                          <input name="originalLanguage" defaultValue={movie.metadata.originalLanguage} className="wr-input" />
                        </label>
                        <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                          Countries (comma-separated)
                          <input name="countries" defaultValue={movie.metadata.productionCountries.join(", ")} className="wr-input" />
                        </label>
                      </div>
                    </form>
                  );
                })()}
              </div>

              {/* Sticky footer */}
              <div className={`shrink-0 flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:justify-end sm:px-6 ${palette ? "border-[color-mix(in_srgb,var(--movie-accent)_20%,rgb(120_113_108/0.25))] bg-[color-mix(in_srgb,var(--movie-column-wash)_14%,var(--wr-surface-cream))] dark:border-[color-mix(in_srgb,var(--movie-accent)_22%,rgb(245_240_232/0.1))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_14%,rgb(18_13_9))]" : "border-stone-900/10 dark:border-white/10"}`}>
                <button form="edit-movie-form" type="submit" className="wr-btn-primary">
                  Save movie info
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {editingSighting && canEditSightings ? (
          <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 p-6">
            <div className={`flex flex-col w-full max-w-3xl overflow-hidden rounded-t-3xl border-2 border-stone-950/22 shadow-[0_-8px_40px_rgb(0_0_0/0.35)] sm:rounded-2xl sm:shadow-[0_20px_60px_rgb(0_0_0/0.45)] ${palette ? "bg-[var(--wr-surface-cream)] dark:border-[color-mix(in_srgb,var(--movie-accent)_20%,rgb(255_255_255/0.18))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_10%,rgb(24_19_15))]" : "bg-white dark:border-white/20 dark:bg-stone-900"}`} style={{ maxHeight: "min(92dvh, 92vh)" }}>
              {/* Sticky header */}
              <div className={`shrink-0 flex items-center gap-3 border-b px-5 py-4 sm:px-6 sm:py-5 ${palette ? "border-[color-mix(in_srgb,var(--movie-accent)_20%,rgb(120_113_108/0.25))] bg-[color-mix(in_srgb,var(--movie-column-wash)_14%,var(--wr-surface-cream))] dark:border-[color-mix(in_srgb,var(--movie-accent)_22%,rgb(245_240_232/0.1))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_14%,rgb(18_13_9))]" : "border-stone-900/10 dark:border-white/10"}`}>
                <h2 className="min-w-0 flex-1 truncate text-lg font-black text-stone-950 dark:text-stone-100">
                  Edit sighting
                </h2>
                <Link
                  href={sightingsBasePath}
                  className="wr-btn-ghost inline-flex h-9 w-9 shrink-0 items-center justify-center px-0 py-0"
                  aria-label="Close"
                  title="Close"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="size-4" aria-hidden="true">
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                  </svg>
                </Link>
              </div>

              {/* Scrollable body */}
              <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto px-5 sm:px-6">
                <EditSightingForm
                  formId="edit-sighting-form"
                  sighting={editingSighting}
                  slug={slug}
                  returnTo={sightingsBasePath}
                  isSeriesTitle={isSeriesTitle}
                  updateAction={updateSightingInfo}
                  deleteAction={deleteSighting}
                  movieIdentity={
                    editingSighting.id.startsWith("queue-")
                      ? { movieTitle: movie.title, imdbId: movie.externalIds.imdb }
                      : undefined
                  }
                />
              </div>

              {/* Sticky footer */}
              <div className={`shrink-0 flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:justify-end sm:px-6 ${palette ? "border-[color-mix(in_srgb,var(--movie-accent)_20%,rgb(120_113_108/0.25))] bg-[color-mix(in_srgb,var(--movie-column-wash)_14%,var(--wr-surface-cream))] dark:border-[color-mix(in_srgb,var(--movie-accent)_22%,rgb(245_240_232/0.1))] dark:bg-[color-mix(in_srgb,var(--movie-accent)_14%,rgb(18_13_9))]" : "border-stone-900/10 dark:border-white/10"}`}>
                <ConfirmSubmitButton
                  confirmMessage="Delete this sighting? This cannot be undone."
                  type="submit"
                  form="edit-sighting-form"
                  formAction={deleteSighting}
                  className="wr-btn bg-red-100 text-red-900 dark:border-red-400/20 dark:bg-red-950/40 dark:text-red-100"
                >
                  Delete sighting
                </ConfirmSubmitButton>
                <button form="edit-sighting-form" type="submit" className="wr-btn-primary">
                  Save sighting
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}

export default async function MoviesRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: SearchParams;
}) {
  const { slug } = await params;
  const baseMovie = await getCatalogMovieBySlug(slug);
  if (!baseMovie) notFound();
  const type = (baseMovie.metadata.syncSnapshot as Record<string, unknown> | undefined)?.Type;
  if (type === "series") redirect(`/shows/${slug}`);
  return <MoviePage params={params} searchParams={searchParams} />;
}
