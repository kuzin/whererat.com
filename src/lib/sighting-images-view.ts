/**
 * List logic for /moderation/images: filter live sightings by whether they have
 * images, search, sort, page, and find the sighting that follows the one being
 * edited ("Save & next"). Pure, so the page and its server action agree on paths.
 */

import { getSightingImageRefs, getSightingTimestampPercent, type Movie, type Sighting } from "@/lib/whererat";

export type SightingImageFilter = "all" | "without" | "with";

export const SIGHTING_IMAGE_FILTERS: Array<{ id: SightingImageFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "without", label: "Without images" },
  { id: "with", label: "With images" },
];

export const SIGHTING_IMAGES_PAGE_SIZE = 24;
const MAX_QUERY_LENGTH = 200;

type Entry = { sighting: Sighting; movie: Movie };

export type SightingImagesListState = {
  filter: SightingImageFilter;
  q: string;
  /** Omitted means "first page", or the page holding `edit` when one is open. */
  page?: number;
};

export function parseSightingImageFilter(raw: unknown): SightingImageFilter {
  return raw === "without" || raw === "with" ? raw : "all";
}

export function parseSightingImagesQuery(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_QUERY_LENGTH) : "";
}

export function parseSightingImagesPage(raw: unknown): number | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,6}$/.test(text)) return undefined;
  const page = Number(text);
  return page >= 1 ? page : undefined;
}

export function sightingImagesPath(state: Partial<SightingImagesListState> & { edit?: string; toast?: string }): string {
  const params = new URLSearchParams();
  if (state.filter && state.filter !== "all") params.set("filter", state.filter);
  if (state.q) params.set("q", state.q);
  if (state.page && state.page > 1) params.set("page", String(state.page));
  if (state.edit) params.set("edit", state.edit);
  if (state.toast) params.set("toast", state.toast);
  const query = params.toString();
  return query ? `/moderation/images?${query}` : "/moderation/images";
}

export function sightingImageCount(sighting: Sighting): number {
  return getSightingImageRefs(sighting).length;
}

function matchesFilter(entry: Entry, filter: SightingImageFilter): boolean {
  if (filter === "all") return true;
  const hasImages = sightingImageCount(entry.sighting) > 0;
  return filter === "with" ? hasImages : !hasImages;
}

function matchesQuery(entry: Entry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [
    entry.movie.title,
    entry.movie.externalIds.imdb,
    entry.sighting.title,
    entry.sighting.episodeTitle,
  ].some((field) => field?.toLowerCase().includes(needle));
}

/** Movie title A→Z, then each movie's sightings in running order. */
function compareEntries(a: Entry, b: Entry): number {
  return (
    a.movie.title.localeCompare(b.movie.title, "en", { sensitivity: "base" }) ||
    a.movie.releaseYear - b.movie.releaseYear ||
    a.movie.id.localeCompare(b.movie.id) ||
    (getSightingTimestampPercent(a.sighting.timestamp) ?? 0) -
      (getSightingTimestampPercent(b.sighting.timestamp) ?? 0) ||
    a.sighting.id.localeCompare(b.sighting.id)
  );
}

export function buildSightingImagesView<T extends Entry>(
  entries: T[],
  state: SightingImagesListState & { edit?: string },
) {
  const searched = entries.filter((entry) => matchesQuery(entry, state.q)).sort(compareEntries);
  const counts: Record<SightingImageFilter, number> = { all: searched.length, without: 0, with: 0 };
  for (const entry of searched) {
    counts[sightingImageCount(entry.sighting) > 0 ? "with" : "without"] += 1;
  }

  const items = searched.filter((entry) => matchesFilter(entry, state.filter));
  const pageCount = Math.max(1, Math.ceil(items.length / SIGHTING_IMAGES_PAGE_SIZE));
  const editIndex = state.edit ? items.findIndex((entry) => entry.sighting.id === state.edit) : -1;
  const requestedPage =
    state.page ?? (editIndex >= 0 ? Math.floor(editIndex / SIGHTING_IMAGES_PAGE_SIZE) + 1 : 1);
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (page - 1) * SIGHTING_IMAGES_PAGE_SIZE;

  return {
    counts,
    total: items.length,
    page,
    pageCount,
    start,
    pageItems: items.slice(start, start + SIGHTING_IMAGES_PAGE_SIZE),
    /** Looked up in every entry, so a link to a sighting outside the filter still opens. */
    editing: state.edit ? entries.find((entry) => entry.sighting.id === state.edit) : undefined,
    /** 1-based position of the edited sighting in the filtered list, if it is in it. */
    editPosition: editIndex >= 0 ? editIndex + 1 : undefined,
    nextSightingId: editIndex >= 0 ? items[editIndex + 1]?.sighting.id : undefined,
  };
}
