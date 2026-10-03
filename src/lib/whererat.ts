export type ImdbReview = {
  id: string;
  author: string;
  summary: string;
  text: string;
  /** IMDb author rating 1–10, if the reviewer left one. */
  rating?: number;
  /** ISO date string, e.g. "2003-04-12". */
  date: string;
  mentionsRat: boolean;
};

export type ImdbRelatedTitle = {
  /** IMDb title ID, e.g. "tt0368226". */
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  /** IMDb aggregate user rating (e.g. 7.4). */
  rating?: number;
};

export type ImdbVideo = {
  /** IMDb video ID, e.g. "vi1234567890". */
  id: string;
  name: string;
  /** Human label for the content type, e.g. "Trailer", "Clip", "Featurette". */
  contentType?: string;
  thumbnailUrl?: string;
  /** Duration in seconds. */
  runtimeSeconds?: number;
};

export type ImdbImage = {
  /** IMDb image ID. */
  id: string;
  url: string;
  width?: number;
  height?: number;
  caption?: string;
};

export type RatProminence = "blink-and-miss" | "background" | "scene-stealer";
export type SceneType =
  | "live-action"
  | "animated"
  | "symbolic"
  | "swarm"
  | "final-shot";
export type Confidence = "needs-source" | "likely" | "verified";
export type VerificationState = "verified" | "pending" | "rejected";
export type SubmissionStatus = "pending" | "approved" | "rejected";
export type ImdbTitleKind = "movie" | "series";

export const RODENT_TYPE_OPTIONS = [
  { id: "rat", emoji: "🐀", label: "Rat", plural: "rats", openmojiCode: "1F400" },
  { id: "mouse", emoji: "🐁", label: "Mouse", plural: "mice", openmojiCode: "1F401" },
  { id: "squirrel", emoji: "🐿️", label: "Squirrel", plural: "squirrels", openmojiCode: "1F43F" },
  { id: "hamster", emoji: "🐹", label: "Hamster", plural: "hamsters", openmojiCode: "1F439" },
  { id: "guinea-pig", emoji: "🐭", label: "Guinea pig", plural: "guinea pigs", openmojiCode: "1F439" },
  { id: "gerbil", emoji: "🐭", label: "Gerbil", plural: "gerbils", openmojiCode: "1F439" },
  { id: "beaver", emoji: "🦫", label: "Beaver", plural: "beavers", openmojiCode: "1F9AB" },
  { id: "chipmunk", emoji: "🐿️", label: "Chipmunk", plural: "chipmunks", openmojiCode: "1F43F" },
] as const;
export type RodentTypeId = (typeof RODENT_TYPE_OPTIONS)[number]["id"];

/**
 * Sentinel id used when the submitter picks "Other" and provides a free-text
 * species name (`otherRodentLabel`). Not part of `RODENT_TYPE_OPTIONS` — public
 * display helpers fall back to generic "rodent"/"Rodents" wording.
 */
export const OTHER_RODENT_ID = "other";
export const MAX_OTHER_RODENT_LABEL_LENGTH = 60;

export const CONTENT_WARNING_OPTIONS = [
  { id: "rat-dies", emoji: "💀", openmojiCode: "1F480", label: "Rat dies" },
  { id: "rat-harmed", emoji: "🩹", openmojiCode: "1FA79", label: "Rat is harmed" },
  { id: "rat-eaten", emoji: "🐍", openmojiCode: "1F40D", label: "Eaten by predator" },
  { id: "rat-poison", emoji: "☠️", openmojiCode: "2620", label: "Rat is poisoned" },
  { id: "rat-trap", emoji: "🪤", openmojiCode: "1FAA4", label: "Caught in trap" },
  { id: "rat-experiment", emoji: "🔬", openmojiCode: "1F52C", label: "Lab / experiment" },
  { id: "graphic", emoji: "🩸", openmojiCode: "1FA78", label: "Graphic / disturbing" },
  { id: "jump-scare", emoji: "😱", openmojiCode: "1F631", label: "Jump scare" },
] as const;
export type ContentWarningId = (typeof CONTENT_WARNING_OPTIONS)[number]["id"];

export const MOVIE_SIGHTINGS_PAGE_SIZE = 10;

export const movieSightingsSortOptions = [
  "newest",
  "rats",
  "appearance-early",
  "appearance-late",
  "episode",
] as const;

export type MovieSightingsSortOption = (typeof movieSightingsSortOptions)[number];

export const movieSightingsSortLabels: Record<MovieSightingsSortOption, string> = {
  newest: "Latest submission",
  rats: "Most rats (est.)",
  "appearance-early": "Earliest in film",
  "appearance-late": "Latest in film",
  episode: "Episode order",
};

export function getMovieSightingsSortOptions(isSeries: boolean): MovieSightingsSortOption[] {
  if (isSeries) {
    return ["newest", "rats", "episode"];
  }
  return ["newest", "rats", "appearance-early", "appearance-late"];
}

export type Movie = {
  id: string;
  slug: string;
  title: string;
  releaseYear: number;
  runtimeMinutes: number;
  genres: string[];
  posterTone: string /** Tailwind bg-* class for poster accent stripe */;
  posterUrl: string;
  backdropUrl: string;
  posterAlt: string;
  externalIds: {
    tmdb?: string;
    imdb: string;
  };
  metadata: {
    tagline: string;
    rating: string;
    director: string;
    originalLanguage: string;
    productionCountries: string[];
    metadataProvider:
    | "IMDb seed"
    | "OMDb via IMDb ID"
    | "Licensed IMDb data"
    | "TMDB keyword seed";
    lastSyncedAt: string;
    /** Last banner URL resolved during sync (used as stable default hero source). */
    syncedHeaderBannerUrl?: string;
    /** Single accent color override — palette is auto-derived from this. null explicitly clears a previously saved value. */
    overrideAccent?: string | null;
    /** Optional manual page color overrides used by the movie page. null explicitly clears a saved palette. */
    pagePalette?: {
      wash: string;
      columnWash: string;
      accent: string;
      heroBloom: string;
    } | null;
    pagePaletteDark?: {
      wash: string;
      columnWash: string;
      accent: string;
      heroBloom: string;
    } | null;
    /** Raw snapshot of fields pulled from the most recent sync run. */
    syncSnapshot?: Record<string, unknown>;
    /** Human-readable field labels that changed in the latest sync. */
    lastSyncChangedFields?: string[];
    /** Screenplay / story credits (IMDb-style line). */
    writers?: string;
    /** Principal cast, comma-separated. */
    cast?: string;
    /** IMDb user rating, e.g. "8.2". */
    imdbRating?: string;
    /** Vote count snapshot for display, e.g. "935,000". */
    imdbVotes?: string;
    /** Metacritic Metascore (0–100). */
    metascore?: string;
    /** Short awards / honors line from public listings. */
    awards?: string;
    /**
     * IMDb trivia entries that mention rats, fetched via Just One API during resync.
     * Plain text, HTML tags stripped, up to 3 entries.
     */
    ratFacts?: string[];
    /** User reviews pulled from IMDb's public GraphQL API during resync (up to 20). */
    imdbReviews?: ImdbReview[];
    /** Titles IMDb recommends as "more like this" (up to 12). */
    imdbRelated?: ImdbRelatedTitle[];
    /** Trailers / clips listed on the IMDb title page (up to 10). */
    imdbVideos?: ImdbVideo[];
    /** Production stills / photos listed on the IMDb title page (up to 24). */
    imdbImages?: ImdbImage[];
    /** YouTube video key for the primary official trailer, sourced from TMDB. */
    youtubeTrailerKey?: string;
    /** Accent color palette cached during last sync (avoids per-request sharp processing). */
    syncedPalette?: {
      wash: string;
      columnWash: string;
      accent: string;
      heroBloom: string;
    };
    syncedPaletteDark?: {
      wash: string;
      columnWash: string;
      accent: string;
      heroBloom: string;
    };
  };
  summary: string;
};

export type Source = {
  id: string;
  label: string;
  url?: string;
  note: string;
};

export type SightingImageSlot = {
  url: string;
  alt?: string;
  /** 0–100, object-position X percentage. Defaults to 50 (centered). */
  positionX?: number;
  /** 0–100, object-position Y percentage. Defaults to 50 (centered). */
  positionY?: number;
  /** ≥ 1, CSS scale factor applied at the position. Defaults to 1. */
  zoom?: number;
};

/**
 * A user- or seed-authored rat moment. All film metadata (title, IMDb, artwork, runtime, …)
 * lives on {@link Movie}; this type only links via `movieId` plus sighting-specific fields.
 */
export type Sighting = {
  id: string;
  movieId: string;
  /** Moment the rat first appears, stored as percent (e.g. "42%") or legacy timecode. */
  timestamp: string;
  /** Short headline for the card (separate from scene description). */
  title?: string;
  description: string;
  prominence: RatProminence;
  sceneType: SceneType;
  spoiler: boolean;
  confidence: Confidence;
  verificationState: VerificationState;
  verifiedBy: string;
  sourceIds: string[];
  /** Optional curator note shown on the title page only when set. */
  curatorNote?: string;
  /** Estimated rats on screen at this timestamp (shown on sightings; fuels “most rats” sort). */
  approximateRatCount?: number;
  /**
   * Up to five images for this sighting (carousel).
   * `imageUrl` / `imageAlt` remain supported for legacy seed rows.
   */
  images?: SightingImageSlot[];
  /** Hosted sighting photo; omit (or omit only for catalog) when there is no still. */
  imageUrl?: string;
  imageAlt?: string;
  /** Community display name shown as “Submitted by …” when set (catalog seeds usually omit). */
  submitterName?: string;
  /** ISO timestamp from moderator review when promoted from an approved submission (for sorting). */
  submissionReviewedAtISO?: string;
  /** IMDb kind + episodic context for series submissions. */
  imdbKind?: ImdbTitleKind;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  contentWarnings?: string[];
  /** One or more rodent type ids (from RODENT_TYPE_OPTIONS). Defaults to ["rat"] when absent. */
  rodentTypes?: string[];
  /** Free-text species name when `rodentTypes` is `["other"]`. Rendered as a public chip. */
  otherRodentLabel?: string;
};

export function clampApproximateRatCount(value: unknown): number {
  const raw = String(value ?? "").trim();
  // Plain digit runs go through Number() so a 309+ digit string becomes Infinity
  // (clamped to 9999) rather than failing parseInt's finite check and collapsing to 1.
  if (/^\+?\d+$/.test(raw)) {
    const big = Number(raw);
    return big < 1 ? 1 : Math.min(9999, Math.floor(big));
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(9999, Math.floor(n));
}

/**
 * Moderation-queue row. `movieTitle` / `moviePosterUrl` / `imdbId` are for triage and
 * creating a {@link Movie} on approval—published {@link Sighting} records do not repeat
 * these fields; they use `movieId` only.
 */
export type Submission = {
  id: string;
  movieTitle: string;
  movieYear?: number;
  imdbId?: string;
  imdbKind?: ImdbTitleKind;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  /** Submission moment, stored as percent (e.g. "42%") or legacy timecode. */
  timestamp: string;
  /** Sighting headline shown on the movie page when promoted to the catalog. */
  title?: string;
  description: string;
  spoiler: boolean;
  /** Contributor/moderator estimate of how many rats appear in the cited moment */
  approximateRatCount: number;
  status: SubmissionStatus;
  submittedBy: string;
  /** Optional contact shared with moderators; not shown on public cards. */
  submitterEmail?: string;
  /** ISO timestamp when submission was created. */
  submittedAt: Date;
  /** Optional curator message shown on approved sightings. */
  curatorNote?: string;
  duplicateHint?: string;
  imageUrl?: string;
  imageAlt?: string;
  /** Up to five queued images (URLs after upload). First also mirrored to `imageUrl` for moderation thumb. */
  images?: SightingImageSlot[];
  moviePosterUrl?: string;
  contentWarnings?: string[];
  rodentTypes?: string[];
  /** Free-text species name when `rodentTypes` is `["other"]`. Moderator-visible only. */
  otherRodentLabel?: string;
};

export function formatSubmissionEpisodeContext(submission: Pick<
  Submission,
  "imdbKind" | "seasonNumber" | "episodeNumber" | "episodeTitle"
>): string | undefined {
  if (submission.imdbKind !== "series") return undefined;
  const s = submission.seasonNumber;
  const e = submission.episodeNumber;
  if (!Number.isFinite(s) || !Number.isFinite(e) || !s || !e) return undefined;
  const base = `S${s}E${e}`;
  const title = submission.episodeTitle?.trim();
  return title ? `${base} · ${title}` : base;
}

export type ReviewAction = {
  id: string;
  submissionId: string;
  movieTitle: string;
  action: "approved" | "edited" | "edited and approved" | "merged duplicate" | "rejected";
  moderatorId: string;
  moderatorName: string;
  reviewedAt: string;
  note: string;
};

export function normalizeImdbId(value: string) {
  const match = value.trim().match(/tt\d{7,9}(?!\d)/i);
  return match?.[0].toLowerCase() ?? "";
}

export function getImdbTitleUrl(imdbId: string) {
  return `https://www.imdb.com/title/${imdbId}/`;
}

/** Comma-split credit lines used for writers, directors, and cast. */
export function splitImdbCreditSegments(line: string): string[] {
  return line
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Name search on IMDb (no `nm` IDs in seed data). Trailing parts like "(voice)"
 * are trimmed from the query for better matches while the link label stays full text.
 */
export function getImdbNameSearchUrl(creditSegment: string): string {
  const trimmed = creditSegment.trim();
  const stripped = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const q = stripped.length > 0 ? stripped : trimmed;
  const url = new URL("https://www.imdb.com/find/");
  url.searchParams.set("q", q);
  url.searchParams.set("s", "nm");
  return url.toString();
}

export function formatRuntimeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) {
    return "";
  }
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) {
    return `${m} min`;
  }
  if (m === 0) {
    return `${h} hr`;
  }
  return `${h} hr ${m} min`;
}

const PLACEHOLDER_STILL_PATTERN = /placehold\.co\//i;

function isNonPlaceholderImageUrl(url: string): boolean {
  const t = url.trim();
  return Boolean(t) && !PLACEHOLDER_STILL_PATTERN.test(t);
}

/**
 * Non-placeholder image refs for a sighting, max five: `images[]` plus legacy `imageUrl`.
 */
export function getSightingImageRefs(sighting: Sighting): SightingImageSlot[] {
  const out: SightingImageSlot[] = [];
  const seen = new Set<string>();
  const push = (slot: SightingImageSlot) => {
    if (!isNonPlaceholderImageUrl(slot.url)) return;
    const key = slot.url.trim().split("?")[0] ?? slot.url.trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      url: slot.url.trim(),
      alt: slot.alt?.trim() || undefined,
      positionX: slot.positionX,
      positionY: slot.positionY,
      zoom: slot.zoom,
    });
  };

  for (const slot of sighting.images ?? []) {
    if (out.length >= 5) break;
    push(slot);
  }
  if (out.length < 5 && sighting.imageUrl) {
    push({ url: sighting.imageUrl, alt: sighting.imageAlt });
  }
  return out.slice(0, 5);
}

/** Show a hero image only for real uploads, not SVG/placeholder stubs. */
export function sightingHasUploadedImage(sighting: Sighting): boolean {
  return getSightingImageRefs(sighting).length > 0;
}

/** Like `getSightingImageRefs` for moderator queue rows. */
export function getSubmissionImageRefs(submission: Submission): SightingImageSlot[] {
  const out: SightingImageSlot[] = [];
  const seen = new Set<string>();
  const push = (slot: SightingImageSlot) => {
    if (!isNonPlaceholderImageUrl(slot.url)) return;
    const key = slot.url.trim().split("?")[0] ?? slot.url.trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      url: slot.url.trim(),
      alt: slot.alt?.trim() || undefined,
      positionX: slot.positionX,
      positionY: slot.positionY,
      zoom: slot.zoom,
    });
  };

  for (const slot of submission.images ?? []) {
    if (out.length >= 5) break;
    push(slot);
  }
  if (out.length < 5 && submission.imageUrl) {
    push({ url: submission.imageUrl, alt: submission.imageAlt });
  }
  return out.slice(0, 5);
}

/** Human line for on-card rat estimate. */
export function formatApproximateRatLine(count: number, rodentTypes?: string[]): string {
  const n = Math.max(1, Math.min(9999, Math.floor(Number(count))));
  if (rodentTypes && rodentTypes.length === 1) {
    if (rodentTypes[0] === OTHER_RODENT_ID) {
      return n === 1 ? "Approx. 1 rodent" : `Approx. ${n} rodents`;
    }
    const opt = RODENT_TYPE_OPTIONS.find((o) => o.id === rodentTypes[0]);
    const singular = opt?.label ?? "rat";
    const plural = opt?.plural ?? "rats";
    return n === 1 ? `Approx. 1 ${singular}` : `Approx. ${n} ${plural}`;
  }
  if (rodentTypes && rodentTypes.length >= 2) {
    return n === 1 ? "Approx. 1 rodent" : `Approx. ${n} rodents`;
  }
  return n === 1 ? "Approx. 1 rat" : `Approx. ${n} rats`;
}

/**
 * Label for the count stepper in the submit/edit forms.
 * "Mice on screen" for a single mouse selection, "Rodents on screen" for multi.
 */
export function rodentCountFieldLabel(rodentTypes?: string[]): string {
  const types = rodentTypes && rodentTypes.length > 0 ? rodentTypes : ["rat"];
  if (types.length === 1) {
    if (types[0] === OTHER_RODENT_ID) return "Rodents on screen";
    const opt = RODENT_TYPE_OPTIONS.find((o) => o.id === types[0]);
    const plural = opt?.plural ?? "rats";
    return `${plural.charAt(0).toUpperCase()}${plural.slice(1)} on screen`;
  }
  return "Rodents on screen";
}

/** Singular noun used for swarm signal labels ("Rat apocalypse", "Mouse apocalypse", "Rodent apocalypse"). */
export function rodentSwarmNoun(rodentTypes?: string[]): string {
  const types = rodentTypes && rodentTypes.length > 0 ? rodentTypes : ["rat"];
  if (types.length === 1) {
    if (types[0] === OTHER_RODENT_ID) return "Rodent";
    const opt = RODENT_TYPE_OPTIONS.find((o) => o.id === types[0]);
    return opt?.label ?? "Rat";
  }
  return "Rodent";
}

/** Plural noun for page headings ("Rats", "Mice", "Rodents", etc.). */
export function rodentSwarmNounPlural(rodentTypes?: string[]): string {
  const types = rodentTypes && rodentTypes.length > 0 ? rodentTypes : ["rat"];
  if (types.length === 1) {
    if (types[0] === OTHER_RODENT_ID) return "Rodents";
    const opt = RODENT_TYPE_OPTIONS.find((o) => o.id === types[0]) as typeof RODENT_TYPE_OPTIONS[number] | undefined;
    const plural = opt?.plural;
    const label = opt?.label ?? "Rat";
    if (plural) return plural.charAt(0).toUpperCase() + plural.slice(1);
    return `${label}s`;
  }
  return "Rodents";
}

/**
 * Returns a content warning label adapted to the actual rodent type.
 * Labels that contain "Rat" (e.g. "Rat dies", "Rat is harmed") are rewritten
 * to match the sighting's rodent context ("Mouse dies", "Rodent is harmed", etc.).
 * Generic labels ("Eaten by predator", "Jump scare") are returned unchanged.
 */
export function formatContentWarningLabel(id: string, rodentTypes?: string[]): string {
  const opt = CONTENT_WARNING_OPTIONS.find((o) => o.id === id);
  const label = opt?.label ?? id;
  if (!label.includes("Rat")) return label;
  const noun = rodentSwarmNoun(rodentTypes);
  return label.replace(/\bRat\b/g, noun);
}

function parseColonTimestamp(value: string): { h: number; m: number; s: number } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const chunks = trimmed.split(":").map((x) => Number.parseInt(x.trim(), 10));
  if (!chunks.every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (chunks.length === 3) {
    return { h: chunks[0]!, m: chunks[1]!, s: chunks[2]! };
  }
  if (chunks.length === 2) {
    return { h: 0, m: chunks[0]!, s: chunks[1]! };
  }
  return null;
}

function parsePercentIntoMovie(value: string): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,3})(?:\s*%)?$/);
  if (!match) return null;
  const percent = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, percent));
}

export function getSightingTimestampPercent(value: string): number | null {
  return parsePercentIntoMovie(value);
}

/**
 * Convert a percentage + runtime to a human-readable timestamp.
 * @param percentStr - A percentage string like "42%" or "42"
 * @param runtimeMinutes - Movie runtime in minutes
 * @returns A formatted timestamp like "56m 24s" or null if unable to parse
 */
export function formatPercentAsTimestamp(percentStr: string, runtimeMinutes?: number): string | null {
  if (!runtimeMinutes || runtimeMinutes <= 0) return null;
  const percent = parsePercentIntoMovie(percentStr);
  if (percent === null) return null;
  const totalSeconds = Math.round((percent / 100) * runtimeMinutes * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return formatClockParts({ h: hours, m: minutes, s: seconds });
}

export function normalizeSightingTimestampInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const percent = parsePercentIntoMovie(trimmed);
  if (percent === null) return trimmed;
  return `${percent}%`;
}

export function formatSightingMomentDisplay(raw: string): string {
  const percent = parsePercentIntoMovie(raw);
  if (percent !== null) return `${percent}%`;
  return formatOneTimecode(raw.trim());
}

function formatClockParts(parts: { h: number; m: number; s: number }): string {
  const sec = parts.s.toString().padStart(2, "0");
  if (parts.h === 0) {
    return `${parts.m}m ${sec}s`;
  }
  const min = parts.m.toString().padStart(2, "0");
  return `${parts.h}h ${min}m ${sec}s`;
}

function formatOneTimecode(raw: string): string {
  const parsed = parseColonTimestamp(raw);
  if (!parsed) return raw.trim();
  return formatClockParts(parsed);
}

/** Human-friendly film time from a `HH:MM:SS` or `MM:SS` string. */
export function formatColonTimecodeDisplay(raw: string): string {
  return formatSightingMomentDisplay(raw);
}

/**
 * Human-friendly starting time for the sighting: "17m 42s" or "1h 02m 15s".
 */
export function formatSightingStartingTimeDisplay(sighting: Sighting): string {
  return formatColonTimecodeDisplay(sighting.timestamp);
}

export function formatSightingEpisodeContext(
  sighting: Pick<
    Sighting,
    "imdbKind" | "seasonNumber" | "episodeNumber" | "episodeTitle"
  >,
): string | undefined {
  if (sighting.imdbKind !== "series") return undefined;
  const s = sighting.seasonNumber;
  const e = sighting.episodeNumber;
  if (!Number.isFinite(s) || !Number.isFinite(e) || !s || !e) return undefined;
  const code = `S${s}E${e}`;
  const title = sighting.episodeTitle?.trim();
  return title ? `${code} · ${title}` : code;
}

function firstMeaningfulLine(value: string): string {
  const t = value.trim();
  if (!t) return "";
  const sentence = t.match(/^[\s\S]{1,200}?[.!?](?=\s|$)/);
  if (sentence) return sentence[0].trim();
  // Cut by code point so an emoji's surrogate pair is never split.
  const chars = Array.from(t);
  return chars.length > 120 ? `${chars.slice(0, 117).join("")}…` : t;
}

/** Headline for a sighting card (explicit title, or a short line from the description). */
export function getSightingCardHeadline(sighting: Sighting): string {
  const raw = sighting.title?.trim();
  if (raw) return raw;
  const fromDesc = firstMeaningfulLine(sighting.description);
  return fromDesc || "Sighting";
}

export function getSubmissionSightingTitle(submission: Submission): string {
  const raw = submission.title?.trim();
  if (raw) return raw;
  return firstMeaningfulLine(submission.description) || "Sighting";
}

const moviesCatalogSeed: Movie[] = [];

export const sources: Source[] = [
  {
    id: "studio-watch-note",
    label: "Curator watch note",
    note: "Timestamp verified by a full-film watch-through.",
  },
  {
    id: "public-domain-print",
    label: "Public-domain reference",
    note: "Scene details checked against a public-domain print.",
  },
  {
    id: "community-citation",
    label: "Community citation",
    note: "Submitted with approximate position in the film and description; awaiting a second pass.",
  },
  {
    id: "tmdb-keyword-rat",
    label: "TMDB “rat” keyword",
    note: "Title appears on TMDB under the “rat” keyword; scene-level details need curator verification.",
  },
  {
    id: "wikipedia-en-intro",
    label: "English Wikipedia intro",
    note: "Automatically matched article introduction; summarizes the story, not verified frame-by-frame.",
  },
  {
    id: "omdb-plot-short",
    label: "OMDb short plot",
    note: "Structured plot blurb from OMDb using the IMDb id; may omit specific rat moments.",
  },
  {
    id: "reddit-snippet-unverified",
    label: "Reddit discussion (unverified)",
    note: "Informal snippet from public search results; anecdotes are not screened for accuracy.",
  },
];

const sightingsCatalogSeed: Sighting[] = [];

export const submissions: Submission[] = [];

export const reviewActions: ReviewAction[] = [];

/** In-repo catalog baseline (exported to Postgres via `npm run seed:postgres:export`). */
export const movies: Movie[] = moviesCatalogSeed.filter((movie) =>
  Boolean(normalizeImdbId(movie.externalIds?.imdb ?? "")),
);

export const sightings: Sighting[] = [...sightingsCatalogSeed];

const sightingCatalogRank = new Map(
  sightings.map((sighting, index) => [sighting.id, index]),
);

export function getSightingCatalogRank(sightingId: string): number {
  return sightingCatalogRank.get(sightingId) ?? 0;
}

/** Newest-first: moderator-promoted sightings sort by review time; catalog uses seed order rank. */
export function sightingNewestSortValue(sighting: Sighting): number {
  if (sighting.submissionReviewedAtISO) {
    const ms = Date.parse(sighting.submissionReviewedAtISO);
    if (Number.isFinite(ms)) return ms;
  }
  return getSightingCatalogRank(sighting.id);
}

export function sightingAppearanceStartSeconds(sighting: Sighting): number {
  const percent = parsePercentIntoMovie(sighting.timestamp);
  if (percent !== null) {
    return percent * 60;
  }
  const chunks = sighting.timestamp
    .trim()
    .split(":")
    .map((segment) => Number.parseInt(segment, 10));
  if (
    chunks.length === 3 &&
    chunks.every((n) => Number.isFinite(n) && !Number.isNaN(n))
  ) {
    return chunks[0] * 3600 + chunks[1] * 60 + chunks[2];
  }
  if (
    chunks.length === 2 &&
    chunks.every((n) => Number.isFinite(n) && !Number.isNaN(n))
  ) {
    return chunks[0] * 60 + chunks[1];
  }
  return 0;
}

function sightingAppearanceSortValue(
  sighting: Sighting,
  runtimeMinutes?: number,
): number {
  const percent = parsePercentIntoMovie(sighting.timestamp);
  if (percent !== null) return percent;
  const seconds = sightingAppearanceStartSeconds(sighting);
  const runtimeSeconds = Math.max(1, Math.floor((runtimeMinutes ?? 0) * 60));
  if (runtimeSeconds > 1) {
    return (seconds / runtimeSeconds) * 100;
  }
  return seconds;
}

function sightingEpisodeSortValue(
  sighting: Pick<Sighting, "seasonNumber" | "episodeNumber">,
): number {
  const season = Number.isFinite(sighting.seasonNumber)
    ? Math.max(0, Math.floor(sighting.seasonNumber as number))
    : 0;
  const episode = Number.isFinite(sighting.episodeNumber)
    ? Math.max(0, Math.floor(sighting.episodeNumber as number))
    : 0;
  return season * 10_000 + episode;
}

export function parseMovieSightingsSortParam(
  value: string | undefined,
): MovieSightingsSortOption {
  if (
    value === "rats" ||
    value === "newest" ||
    value === "appearance-early" ||
    value === "appearance-late" ||
    value === "episode"
  ) {
    return value;
  }
  return "newest";
}

export function parseMovieSightingsPageParam(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? "1").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export function movieSightingsQueryString(parts: {
  sort: MovieSightingsSortOption;
  page: number;
}): string {
  const p = new URLSearchParams();
  if (parts.sort !== "newest") p.set("sort", parts.sort);
  if (parts.page > 1) p.set("page", String(parts.page));
  return p.toString();
}

export function buildMovieSightingsPath(
  moviePath: string,
  parts: {
    sort: MovieSightingsSortOption;
    page: number;
  },
): string {
  const q = movieSightingsQueryString(parts);
  return q ? `${moviePath}?${q}` : moviePath;
}

/** Returns the canonical web path for a movie or TV series. */
export function getMoviePath(movie: Movie): string {
  const type = (movie.metadata.syncSnapshot as Record<string, unknown> | undefined)?.Type;
  return type === "series" ? `/shows/${movie.slug}` : `/movies/${movie.slug}`;
}

export function prepareMovieSightingsView({
  items,
  sort,
  page,
  runtimeMinutes,
  pageSize = MOVIE_SIGHTINGS_PAGE_SIZE,
}: {
  items: Sighting[];
  sort: MovieSightingsSortOption;
  page: number;
  runtimeMinutes?: number;
  pageSize?: number;
}): {
  pageSlice: Sighting[];
  totalCount: number;
  pageCount: number;
  safePage: number;
} {
  const totalCount = items.length;
  const ordered = [...items];
  switch (sort) {
    case "newest":
      ordered.sort(
        (a, b) => sightingNewestSortValue(b) - sightingNewestSortValue(a),
      );
      break;
    case "rats":
      ordered.sort((a, b) => {
        const dr = estimateRatsForAppearance(b) - estimateRatsForAppearance(a);
        if (dr !== 0) return dr;
        return (
          sightingAppearanceSortValue(a, runtimeMinutes) -
          sightingAppearanceSortValue(b, runtimeMinutes)
        );
      });
      break;
    case "appearance-early":
      ordered.sort(
        (a, b) =>
          sightingAppearanceSortValue(a, runtimeMinutes) -
          sightingAppearanceSortValue(b, runtimeMinutes),
      );
      break;
    case "appearance-late":
      ordered.sort(
        (a, b) =>
          sightingAppearanceSortValue(b, runtimeMinutes) -
          sightingAppearanceSortValue(a, runtimeMinutes),
      );
      break;
    case "episode":
      ordered.sort((a, b) => {
        const de = sightingEpisodeSortValue(a) - sightingEpisodeSortValue(b);
        if (de !== 0) return de;
        return (
          sightingAppearanceSortValue(a, runtimeMinutes) -
          sightingAppearanceSortValue(b, runtimeMinutes)
        );
      });
      break;
    default:
      break;
  }

  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  const pageSlice = ordered.slice(start, start + pageSize);

  return {
    pageSlice,
    totalCount,
    pageCount,
    safePage,
  };
}

export function getSightingsForMovie(movieId: string) {
  return sightings.filter((sighting) => sighting.movieId === movieId);
}

/** Sum of catalog rat estimates per sighting (swarms weighted). */
export function estimateTotalRatsForMovie(movieId: string): number {
  return getSightingsForMovie(movieId).reduce(
    (sum, sighting) => sum + estimateRatsForAppearance(sighting),
    0,
  );
}

export function getMovieBySlug(slug: string) {
  return movies.find((movie) => movie.slug === slug);
}

export function getMovieByImdbId(imdbIdOrUrl: string) {
  const imdbId = normalizeImdbId(imdbIdOrUrl);
  return movies.find((movie) => movie.externalIds.imdb === imdbId);
}

export function getMovieByTitleSearch(title: string) {
  const normalizedTitle = title.trim().toLowerCase();

  if (!normalizedTitle) {
    return undefined;
  }

  return movies.find((movie) => {
    const movieLabel = `${movie.title} ${movie.releaseYear}`.toLowerCase();

    return (
      movie.title.toLowerCase() === normalizedTitle ||
      movieLabel === normalizedTitle ||
      movie.title.toLowerCase().includes(normalizedTitle) ||
      normalizedTitle.includes(movie.title.toLowerCase())
    );
  });
}

export function getImdbTitleOptions() {
  return movies.map((movie) => ({
    label: `${movie.title} (${movie.releaseYear})`,
    value: movie.title,
    imdbId: movie.externalIds.imdb,
    posterUrl: movie.posterUrl,
    rating: movie.metadata.rating,
  }));
}

export function getSourceById(sourceId: string) {
  return sources.find((source) => source.id === sourceId);
}

export function getRatCount(movieId: string) {
  return getSightingsForMovie(movieId).length;
}

export function getRecentReviewActions() {
  return [...reviewActions].sort(
    (a, b) =>
      new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime(),
  );
}

/** Rough on-screen headcount for sorting and aggregates — prefers `approximateRatCount`, then scene heuristics. */
export function estimateRatsForAppearance(sighting: Sighting): number {
  const raw = sighting.approximateRatCount;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.min(9999, Math.floor(raw));
  }
  if (sighting.sceneType === "swarm") return 6;
  return 1;
}

export type RatPresenceCaption =
  | "Lone scout"
  | "Small pack"
  | "Merry mischief"
  | "Growing colony"
  | "Rat Swarm"
  | "Rat apocalypse";

export type RatPresenceScale = {
  slotsFilled: 1 | 2 | 3 | 4 | 5 | 6;
  caption: RatPresenceCaption;
  sublabel: string;
};

export function getRatPresenceScale(estimatedCount: number): RatPresenceScale {
  let n = Math.floor(Number(estimatedCount));
  if (!Number.isFinite(n) || n < 1) n = 1;
  n = Math.min(999, n);
  if (n === 1) return { slotsFilled: 1, caption: "Lone scout", sublabel: "A solitary rat. Brave." };
  if (n <= 3) return { slotsFilled: 2, caption: "Small pack", sublabel: "A couple of friends." };
  if (n <= 6) return { slotsFilled: 3, caption: "Merry mischief", sublabel: "The proper collective noun." };
  if (n <= 15) return { slotsFilled: 4, caption: "Growing colony", sublabel: "Things are getting ratty." };
  if (n <= 40) return { slotsFilled: 5, caption: "Rat Swarm", sublabel: "Someone call an exterminator." };
  return { slotsFilled: 6, caption: "Rat apocalypse", sublabel: "We bow to our new overlords." };
}

/**
 * Hero preview cards: later entries in the sightings list are treated as newer catalog drops.
 * Returns up to `limit` verified sightings on distinct movies.
 */
export function getHeroRecentSightings(limit = 3): { sighting: Sighting; movie: Movie }[] {
  const verified = sightings.filter((s) => s.verificationState === "verified");
  const ordered = [...verified].reverse();
  const out: { sighting: Sighting; movie: Movie }[] = [];
  const seen = new Set<string>();

  for (const sighting of ordered) {
    const movie = movies.find((m) => m.id === sighting.movieId);
    if (!movie) continue;
    if (seen.has(movie.id)) continue;
    seen.add(movie.id);
    out.push({ sighting, movie });
    if (out.length >= limit) break;
  }

  return out;
}

export function getCatalogStats() {
  const verifiedSightings = sightings.filter(
    (sighting) => sighting.verificationState === "verified",
  );

  return {
    movies: movies.length,
    sightings: verifiedSightings.length,
    ratsTallied: verifiedSightings.reduce(
      (sum, s) => sum + estimateRatsForAppearance(s),
      0,
    ),
    pendingSubmissions: submissions.filter(
      (submission) => submission.status === "pending",
    ).length,
    spoilerSightings: verifiedSightings.filter((sighting) => sighting.spoiler)
      .length,
  };
}

export function searchMovies({
  query,
  genre,
}: {
  query?: string;
  genre?: string;
}) {
  const normalizedQuery = query?.trim().toLowerCase();

  return movies.filter((movie) => {
    const matchesQuery =
      !normalizedQuery ||
      movie.title.toLowerCase().includes(normalizedQuery) ||
      movie.summary.toLowerCase().includes(normalizedQuery) ||
      movie.externalIds.imdb.toLowerCase().includes(normalizedQuery);
    const matchesGenre = !genre || genre === "all" || movie.genres.includes(genre);

    return matchesQuery && matchesGenre;
  });
}

export const genres = Array.from(
  new Set(movies.flatMap((movie) => movie.genres)),
).sort();

export const prominenceLabels: Record<RatProminence, string> = {
  "blink-and-miss": "Blink And Miss",
  background: "Background",
  "scene-stealer": "Scene Stealer",
};

export const confidenceLabels: Record<Confidence, string> = {
  "needs-source": "Needs Source",
  likely: "Likely",
  verified: "Verified",
};

export const sceneTypeLabels: Record<SceneType, string> = {
  "live-action": "Live Action",
  animated: "Animated",
  symbolic: "Symbolic",
  swarm: "Swarm",
  "final-shot": "Final Shot",
};
