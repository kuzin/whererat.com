import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { getAllMergedSightings } from "@/lib/moderation-store";
import {
  formatSightingMomentDisplay,
  formatSubmissionEpisodeContext,
  getMoviePath,
  getSightingImageRefs,
  type Movie,
  type Sighting,
  type SightingImageSlot,
} from "@/lib/whererat";
import {
  SIGHTING_IMAGE_FILTERS,
  buildSightingImagesView,
  parseSightingImageFilter,
  parseSightingImagesPage,
  parseSightingImagesQuery,
  sightingImagesPath,
  type SightingImagesListState,
} from "@/lib/sighting-images-view";
import { PageHeader } from "@/components/layout/page-header";
import { SightingMarkdown } from "@/components/ui/sighting-markdown";
import { SightingImagesModal } from "./sighting-images-modal";

export const metadata: Metadata = {
  title: "Sighting Images",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const MAX_ROW_THUMBS = 3;

/** Same framing the gallery editor and public carousel apply (see imagePositionStyle). */
function thumbStyle(slot: SightingImageSlot): CSSProperties {
  const x = slot.positionX ?? 50;
  const y = slot.positionY ?? 50;
  const zoom = slot.zoom ?? 1;
  return {
    objectPosition: `${x}% ${y}%`,
    transform: zoom !== 1 ? `scale(${zoom})` : undefined,
    transformOrigin: `${x}% ${y}%`,
  };
}

/** A pagination step; with no page to go to it is plain text, so keyboards can't land on it. */
function PageLink({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <Link href={href} className="wr-btn-ghost">
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className="wr-btn-ghost cursor-not-allowed opacity-40">
      {children}
    </span>
  );
}

function sightingDetails(sighting: Sighting, movie: Movie): string {
  const isSeries = sighting.imdbKind === "series" || getMoviePath(movie).startsWith("/shows/");
  return [
    formatSubmissionEpisodeContext(sighting),
    `${formatSightingMomentDisplay(sighting.timestamp)} into the ${isSeries ? "episode" : "movie"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default async function SightingImagesPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const cookieStore = await cookies();
  const session = await verifyModeratorSession(cookieStore.get(MODERATOR_SESSION_COOKIE)?.value);
  if (!session) redirect("/login?next=/moderation/images");
  if (session.role !== "owner") redirect("/moderation");

  const params = searchParams ? await searchParams : {};
  const list: SightingImagesListState = {
    filter: parseSightingImageFilter(single(params.filter)),
    q: parseSightingImagesQuery(single(params.q)),
    page: parseSightingImagesPage(single(params.page)),
  };
  const edit = single(params.edit)?.trim() || undefined;

  const view = buildSightingImagesView(await getAllMergedSightings(), { ...list, edit });
  // Paths from here on keep the page actually shown, so closing the editor returns to it.
  const shown: SightingImagesListState = { ...list, page: view.page };
  const pagePath = (page: number) => sightingImagesPath({ ...shown, page });

  const emptyMessage = list.q
    ? `No sightings match “${list.q}”.`
    : list.filter === "without"
      ? "Every sighting has at least one image."
      : list.filter === "with"
        ? "No sightings have images yet."
        : "No live sightings yet. Approved submissions show up here.";

  const editing = view.editing;
  const editingImages = editing ? getSightingImageRefs(editing.sighting) : [];

  return (
    <main className="wr-page-shell py-10">
      <PageHeader back={{ href: "/moderation", label: "Moderation" }} title="Sighting images" />
      <p className="mb-6 max-w-2xl text-sm text-stone-600 dark:text-stone-400">
        Every approved, live sighting in the catalog — pending, rejected and deleted ones never appear here. Open one to add, replace, reframe or remove its images.
      </p>

      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <nav
          aria-label="Filter sightings by images"
          className="inline-flex flex-wrap self-start rounded-xl border border-stone-900/18 bg-white p-1 dark:border-white/12 dark:bg-stone-900/70"
        >
          {SIGHTING_IMAGE_FILTERS.map((option) => {
            const active = option.id === list.filter;
            return (
              <Link
                key={option.id}
                href={sightingImagesPath({ filter: option.id, q: list.q })}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-950/40 focus-visible:ring-offset-2 dark:focus-visible:ring-amber-400/55 dark:focus-visible:ring-offset-stone-900 ${
                  active
                    ? "bg-stone-950 text-amber-100 dark:bg-amber-100 dark:text-stone-950"
                    : "text-stone-700 hover:text-stone-900 dark:text-stone-200 dark:hover:text-white"
                }`}
              >
                {option.label} ({view.counts[option.id]})
              </Link>
            );
          })}
        </nav>

        <form action="/moderation/images" method="get" role="search" className="flex gap-2 lg:w-96">
          {list.filter !== "all" ? <input type="hidden" name="filter" value={list.filter} /> : null}
          <label htmlFor="sighting-images-q" className="sr-only">
            Search sightings
          </label>
          <input
            id="sighting-images-q"
            type="search"
            name="q"
            defaultValue={list.q}
            maxLength={200}
            placeholder="Movie, sighting title or IMDb id"
            className="wr-input min-w-0 flex-1"
          />
          <button type="submit" className="wr-btn-ghost shrink-0">
            Search
          </button>
        </form>
      </div>

      {view.total === 0 ? (
        <p className="rounded-2xl border border-dashed border-stone-300 p-10 text-center text-stone-500 dark:border-stone-700 dark:text-stone-400">
          {emptyMessage}
        </p>
      ) : (
        <ul className="divide-y divide-stone-900/10 rounded-2xl border border-stone-900/12 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-900/70">
          {view.pageItems.map(({ sighting, movie }) => {
            const images = getSightingImageRefs(sighting);
            const hidden = images.length - MAX_ROW_THUMBS;
            return (
              <li
                key={sighting.id}
                className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <img
                    src={movie.posterUrl}
                    alt=""
                    loading="lazy"
                    className="h-16 w-11 shrink-0 rounded-md border border-stone-900/12 object-cover dark:border-white/12"
                  />
                  <div className="min-w-0">
                    <p className="truncate font-bold text-stone-950 dark:text-stone-100">
                      {sighting.title || "Untitled sighting"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                      <Link href={getMoviePath(movie)} className="font-semibold hover:underline">
                        {movie.title} ({movie.releaseYear})
                      </Link>
                      {" · "}
                      {sightingDetails(sighting, movie)}
                    </p>
                    <p className="mt-2">
                      {images.length > 0 ? (
                        <span className="inline-flex rounded-lg border border-green-400/60 bg-green-50 px-2.5 py-1 text-xs font-semibold leading-none text-green-800 dark:border-green-600/30 dark:bg-green-950/20 dark:text-green-400">
                          {images.length} {images.length === 1 ? "image" : "images"}
                        </span>
                      ) : (
                        <span className="inline-flex rounded-lg border border-amber-700/35 bg-amber-100 px-2.5 py-1 text-xs font-semibold leading-none text-amber-950 dark:border-amber-400/25 dark:bg-amber-950/35 dark:text-amber-200">
                          No images
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 sm:shrink-0">
                  {images.length > 0 ? (
                    <div className="flex gap-1.5" aria-hidden>
                      {images.slice(0, MAX_ROW_THUMBS).map((slot) => (
                        <span
                          key={slot.url}
                          className="block h-11 w-16 overflow-hidden rounded-md border border-stone-900/12 bg-stone-100 dark:border-white/12 dark:bg-stone-800"
                        >
                          <img
                            src={slot.url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                            style={thumbStyle(slot)}
                          />
                        </span>
                      ))}
                      {hidden > 0 ? (
                        <span className="flex h-11 w-9 items-center justify-center rounded-md border border-stone-900/12 text-xs font-bold text-stone-500 dark:border-white/12 dark:text-stone-400">
                          +{hidden}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <Link
                    href={sightingImagesPath({ ...shown, edit: sighting.id })}
                    scroll={false}
                    className={`${images.length > 0 ? "wr-btn-ghost" : "wr-btn-primary"} ml-auto sm:ml-0`}
                  >
                    {images.length > 0 ? "Edit images" : "Add images"}
                    <span className="sr-only">
                      {" "}for {sighting.title || "untitled sighting"} in {movie.title}
                    </span>
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {view.pageCount > 1 ? (
        <div className="mt-6 flex items-center justify-between gap-3">
          <PageLink href={view.page > 1 ? pagePath(view.page - 1) : undefined}>← Previous</PageLink>
          <p className="text-sm font-semibold text-stone-600 dark:text-stone-300">
            Showing {view.start + 1}–{view.start + view.pageItems.length} of {view.total}
          </p>
          <PageLink href={view.page < view.pageCount ? pagePath(view.page + 1) : undefined}>Next →</PageLink>
        </div>
      ) : null}

      {editing ? (
        // Keyed per sighting so "Save & next" remounts with a fresh gallery.
        <SightingImagesModal
          key={editing.sighting.id}
          sightingId={editing.sighting.id}
          sightingTitle={editing.sighting.title || "Untitled sighting"}
          movieTitle={editing.movie.title}
          movieYear={editing.movie.releaseYear}
          moviePath={getMoviePath(editing.movie)}
          posterUrl={editing.movie.posterUrl}
          details={sightingDetails(editing.sighting, editing.movie)}
          spoiler={editing.sighting.spoiler}
          initialImages={editingImages.map((slot) => ({
            url: slot.url,
            alt: slot.alt,
            x: slot.positionX,
            y: slot.positionY,
            zoom: slot.zoom,
          }))}
          list={shown}
          closeHref={sightingImagesPath(shown)}
          nextSightingId={view.nextSightingId}
          positionLabel={view.editPosition ? `${view.editPosition} of ${view.total}` : undefined}
          description={<SightingMarkdown markdown={editing.sighting.description} />}
        />
      ) : null}
    </main>
  );
}
