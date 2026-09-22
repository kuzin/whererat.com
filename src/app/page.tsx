import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { getApprovedSubmissionRatTally } from "@/lib/moderation-store";
import { getDeletedMovieIds } from "@/lib/movie-edit-store";
import { estimateRatsForAppearance, getMoviePath, RODENT_TYPE_OPTIONS } from "@/lib/whererat";
import {
  getCatalogGenres,
  getCatalogRodentTypes,
  getCatalogMovies,
  searchCatalogMovies,
  getCatalogStatsWithCommunity,
} from "@/lib/movie-catalog";
import { getMergedSightingsForMovie, getMovieIdsWithRodentType } from "@/lib/moderation-store";
import {
  CatalogFilters,
  CatalogPagination,
  CatalogPendingProvider,
  CatalogResultsWrapper,
  type CatalogSortOption,
  type CatalogView,
} from "@/components/layout/catalog-filters";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: "Catalog",
  description:
    "Browse the WhereRat catalog of rat sightings in movies, with filters, stats, and spoiler-aware entries.",
  alternates: {
    canonical: "/",
  },
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseCatalogSort(value: string | undefined): CatalogSortOption {
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

function readSeriesYearRange(snapshot: Record<string, unknown> | undefined): string | undefined {
  const raw =
    typeof snapshot?.Year === "string"
      ? snapshot.Year
      : typeof snapshot?.year === "string"
        ? snapshot.year
        : "";
  const cleaned = raw.trim();
  if (!cleaned) return undefined;
  // OMDb commonly returns "2008-2013" for series; normalize to an en dash.
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

export default async function Home({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const PAGE_SIZE = 12;
  const params = searchParams ? await searchParams : {};
  const query = single(params.q) ?? "";
  const genre = single(params.genre) ?? "all";
  const rodentType = single(params.rodent) ?? "all";
  const sort = parseCatalogSort(single(params.sort));
  const view: CatalogView = single(params.view) === "card" ? "card" : "list";
  const rawPage = parseInt(single(params.page) ?? "1", 10);
  const currentPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const deletedMovieIds = await getDeletedMovieIds();
  const catalogMovies = await getCatalogMovies();
  const movieIndexById = new Map(catalogMovies.map((movie, index) => [movie.id, index]));
  const rodentMovieIds =
    rodentType === "all" ? undefined : await getMovieIdsWithRodentType(rodentType);
  const filteredResults = (await searchCatalogMovies({ query, genre, rodentMovieIds })).filter(
    (movie) => !deletedMovieIds.has(movie.id),
  );
  const resultMetrics = await Promise.all(
    filteredResults.map(async (movie) => {
      const sightings = await getMergedSightingsForMovie(movie.id);
      const latestSightingMs = sightings.reduce((latest, sighting) => {
        const ms = sighting.submissionReviewedAtISO
          ? Date.parse(sighting.submissionReviewedAtISO)
          : 0;
        return Number.isFinite(ms) ? Math.max(latest, ms) : latest;
      }, 0);
      const ratsLogged = sightings.reduce(
        (sum, sighting) => sum + estimateRatsForAppearance(sighting),
        0,
      );
      return {
        movie,
        sightings,
        sightingCount: sightings.length,
        latestSightingMs,
        ratsLogged,
        catalogIndex: movieIndexById.get(movie.id) ?? 0,
      };
    }),
  );
  const sortedMetrics = [...resultMetrics].sort((a, b) => {
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
  const totalResults = sortedMetrics.length;
  const pageOffset = (currentPage - 1) * PAGE_SIZE;
  const pagedMetrics = sortedMetrics.slice(pageOffset, pageOffset + PAGE_SIZE);
  const results = pagedMetrics.map((item) => item.movie);
  const sightingCountByMovie = new Map(
    pagedMetrics.map((item) => [item.movie.id, item.sightingCount]),
  );
  const sightingsByMovie = new Map(
    pagedMetrics.map((item) => [item.movie.id, item.sightings]),
  );
  const catalogFiltersActive =
    query.trim().length > 0 || genre !== "all" || rodentType !== "all";
  const stats = await getCatalogStatsWithCommunity();
  const approvedSubmissionRats = await getApprovedSubmissionRatTally();
  const ratsTallied = stats.ratsTallied + approvedSubmissionRats;
  const [availableGenres, availableRodentTypes] = await Promise.all([
    getCatalogGenres(),
    getCatalogRodentTypes(),
  ]);

  return (
    <main className="relative flex flex-1 flex-col">
      <section className="py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h1
            className="tracking-normal text-stone-950 dark:text-[#fff8ec]"
            style={{ fontFamily: "var(--font-hero)", fontSize: "clamp(2.2rem, 6.8vw, 4.1rem)" }}
          >
            An obsessive guide to{" "}
            <span className="inline-block -scale-x-100"><img src="/openmoji/color/svg/1F400.svg" alt="Rat" width={48} height={48} style={{ display: "inline", verticalAlign: "middle" }} /></span> on film.
          </h1>
        </div>
      </section>

      <section
        id="catalog"
        className="mx-auto max-w-7xl px-4 pt-0 pb-0 sm:px-6 sm:pt-0 lg:px-8 lg:pt-0"
      >
        <div className="wr-card bg-[#fdfbf7]/95 p-4 sm:p-7 dark:border-white/14 dark:bg-[rgb(40_35_30/0.97)]">
          <CatalogPendingProvider>
            <CatalogFilters
              availableGenres={availableGenres}
              availableRodentTypes={availableRodentTypes}
              defaultQuery={query}
              totalResults={totalResults}
              totalCatalog={catalogMovies.length}
            />

            <CatalogResultsWrapper>
              {totalResults > 0 ? (
                view === "card" ? (
                  <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {results.map((movie) => {
                      const sightingCount = sightingCountByMovie.get(movie.id) ?? 0;
                      const accent = (typeof movie.metadata.overrideAccent === 'string' && movie.metadata.overrideAccent) ? movie.metadata.overrideAccent : movie.metadata.pagePalette?.accent ?? null;
                      const accentStyle = accent ? { '--movie-accent': accent } as React.CSSProperties : undefined;
                      return (
                        <Link
                          key={movie.id}
                          href={getMoviePath(movie)}
                          style={accentStyle}
                          className="group relative overflow-hidden rounded-xl border-2 border-stone-950/90 bg-stone-900 shadow-[2px_2px_0_0_rgb(28_25_23/0.55)] outline-none transition hover:border-[color-mix(in_srgb,var(--movie-accent,#ea580c)_60%,#1c1410)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--movie-accent,#ea580c)_50%,transparent)] dark:border-white/14 dark:shadow-[2px_2px_0_0_rgb(0_0_0/0.48)] dark:hover:border-[color-mix(in_srgb,var(--movie-accent,#ea580c)_55%,white)]"
                        >
                          <div className="relative aspect-[2/3] overflow-hidden">
                            <Image
                              src={movie.posterUrl}
                              alt={movie.posterAlt}
                              width={280}
                              height={420}
                              className="h-full w-full object-cover transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-105 group-hover:opacity-90"
                            />
                            {sightingCount > 0 && (
                              <span className="pointer-events-none absolute bottom-2 left-2 inline-flex items-center rounded-full bg-[color-mix(in_srgb,var(--movie-accent,#ea580c)_85%,#7c2d12)] px-2 py-0.5 text-xs font-bold text-white shadow backdrop-blur-[2px] dark:bg-stone-900/80 dark:text-amber-300">
                                {sightingCount} {sightingCount === 1 ? "sighting" : "sightings"}
                              </span>
                            )}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className="grid gap-5 lg:grid-cols-2">
                    {results.map((movie) => {
                      const sightingCount = sightingCountByMovie.get(movie.id) ?? 0;
                      const sightings = sightingsByMovie.get(movie.id) ?? [];
                      const isSeriesTitle = sightings.some((sighting) => sighting.imdbKind === "series");
                      const syncSnapshot = movie.metadata.syncSnapshot as Record<string, unknown> | undefined;
                      const seriesYearRange = readSeriesYearRange(syncSnapshot);
                      const totalSeasons = readSeriesTotalSeasons(syncSnapshot);
                      const totalEpisodes = readSeriesTotalEpisodes(syncSnapshot);
                      const seriesMetaLine = [
                        seriesYearRange ?? String(movie.releaseYear),
                        totalSeasons
                          ? `${totalSeasons} ${totalSeasons === 1 ? "season" : "seasons"}`
                          : undefined,
                        totalEpisodes
                          ? `${totalEpisodes} ${totalEpisodes === 1 ? "episode" : "episodes"}`
                          : undefined,
                        movie.metadata.rating || undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const movieMetaLine = `${movie.releaseYear} · ${movie.runtimeMinutes} min · ${movie.metadata.rating}`;
                      const accent = (typeof movie.metadata.overrideAccent === 'string' && movie.metadata.overrideAccent) ? movie.metadata.overrideAccent : movie.metadata.pagePalette?.accent ?? null;
                      const accentStyle = accent ? { '--movie-accent': accent } as React.CSSProperties : undefined;

                      return (
                        <Link
                          key={movie.id}
                          href={getMoviePath(movie)}
                          style={accentStyle}
                          className="group relative grid overflow-hidden rounded-2xl border-2 border-stone-950/90 bg-[var(--wr-surface-cream)] shadow-[3px_3px_0_0_rgb(28_25_23/0.72)] outline-none transition hover:border-[color-mix(in_srgb,var(--movie-accent,#ea580c)_60%,#1c1410)] hover:bg-[var(--wr-card-bg)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--movie-accent,#ea580c)_50%,transparent)] focus-visible:ring-offset-2 dark:border-white/14 dark:bg-stone-900/70 dark:shadow-[3px_3px_0_0_rgb(0_0_0/0.48)] dark:hover:border-[color-mix(in_srgb,var(--movie-accent,#ea580c)_55%,white)] dark:hover:bg-stone-900/95 dark:focus-visible:ring-[color-mix(in_srgb,var(--movie-accent,#ea580c)_50%,transparent)] dark:focus-visible:ring-offset-stone-900 sm:grid-cols-[160px_1fr]"
                        >
                          <div className="relative h-56 overflow-hidden border-stone-950/90 bg-stone-900 sm:h-auto sm:border-r-2 dark:border-white/14">
                            <Image
                              src={movie.posterUrl}
                              alt={movie.posterAlt}
                              width={280}
                              height={420}
                              className="h-full w-full scale-[1.04] object-cover object-top transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-100 group-hover:opacity-95 sm:min-h-full sm:object-center"
                            />
                            {sightingCount > 0 && (
                              <span className="absolute bottom-2 left-2 inline-flex items-center rounded-full bg-[color-mix(in_srgb,var(--movie-accent,#ea580c)_85%,#7c2d12)] px-2 py-0.5 text-xs font-bold text-white shadow dark:bg-[color-mix(in_srgb,var(--movie-accent,#ea580c)_70%,#000)] dark:text-white">
                                {sightingCount} {sightingCount === 1 ? "sighting" : "sightings"}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-col justify-center gap-3 p-4 sm:p-5">
                            <div className="min-w-0">
                              <h3 className="wr-display text-xl font-bold leading-snug tracking-tight text-stone-950 group-hover:text-stone-800 dark:text-stone-50 dark:group-hover:text-amber-50 sm:text-2xl">
                                {movie.title}
                              </h3>
                              <p className="mt-1 text-sm font-semibold text-stone-600 dark:text-stone-400">
                                {isSeriesTitle ? seriesMetaLine : movieMetaLine}
                              </p>
                            </div>
                            <p className="line-clamp-2 text-sm leading-relaxed text-stone-700 dark:text-stone-400">
                              {movie.summary}
                            </p>
                            <p className="text-xs font-semibold text-stone-500 dark:text-stone-500">
                              {movie.genres.join(" · ")}
                            </p>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )
              ) : null}

              {totalResults > 0 && (
                <CatalogPagination
                  totalResults={totalResults}
                  currentPage={currentPage}
                  pageSize={PAGE_SIZE}
                />
              )}

              {totalResults === 0 ? (
                <div className="mt-6 rounded-2xl border-2 border-dashed border-stone-900/30 bg-orange-100/75 p-10 text-center dark:border-stone-600/50 dark:bg-orange-950/30">
                  <img src="/openmoji/color/svg/1F9C0.svg" alt="Cheese" width={40} height={40} className="mx-auto" />
                  <h3 className="wr-display mt-4 text-2xl font-bold text-stone-950 dark:text-stone-100">
                    No {RODENT_TYPE_OPTIONS.find((r) => r.id === rodentType)?.plural ?? "rats"} in this hole.
                  </h3>
                  <p className="mt-2 text-stone-700 dark:text-stone-400">
                    Widen those filters—or submit a cheeky sighting so moderators can
                    take a peek.
                  </p>
                  {catalogFiltersActive ? (
                    <div className="mt-6 flex justify-center">
                      <Link
                        href="/#catalog"
                        className="wr-btn-ghost px-6 py-2.5 text-sm font-bold"
                      >
                        Reset filters
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CatalogResultsWrapper>
          </CatalogPendingProvider>
        </div>
      </section>
      <section aria-hidden className="flex flex-1 flex-col items-center justify-center py-15 text-center select-none">
        <img src="/openmoji/color/svg/1F400.svg" alt="Rat" width={48} height={48} className="mx-auto" />
        <p className="mt-3 text-sm font-medium text-stone-400 dark:text-stone-600">
          {ratsTallied.toLocaleString()} rats catalogued. Still scurrying.
        </p>
      </section>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[var(--background)]"
      />
    </main>
  );
}
