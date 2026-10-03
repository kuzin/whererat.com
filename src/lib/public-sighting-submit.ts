/**
 * Shared public sighting submission path for the web submit server action and
 * `POST /api/v1/submissions` (native clients). No moderator auto-approve here.
 */

import {
  MAX_OTHER_RODENT_LABEL_LENGTH,
  OTHER_RODENT_ID,
  clampApproximateRatCount,
  normalizeImdbId,
  normalizeSightingTimestampInput,
  type SightingImageSlot,
} from "@/lib/whererat";
import { addSubmission } from "@/lib/moderation-store";
import { findCatalogMovieForSubmission } from "@/lib/movie-catalog";
import {
  persistSightingFiles,
  parseSightingImageGalleryForm,
  SIGHTING_GALLERY_FIELD_NAMES,
  SIGHTING_GALLERY_SENTINEL,
} from "@/lib/media-storage";
import { notifyOwnerOfNewSubmission } from "@/lib/moderation-notify";
import { notifySubmitterOfReceipt } from "@/lib/submitter-notify";
import { consumeSharedRateLimit } from "@/lib/rate-limit-store";
import {
  SUBMISSION_LIMITS,
  cleanContentWarnings,
  cleanRodentTypes,
  cleanText,
  isOwnStorageUrl,
  isValidTimestamp,
  parseReleaseYear,
  parseSeasonOrEpisode,
  sanitizePosterUrl,
} from "@/lib/submission-input";

const MAX_SIGHTING_UPLOAD_BYTES = 8 * 1024 * 1024;

const _rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function normalizeOptionalSubmitterEmail(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (raw.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    return undefined;
  }
  return raw;
}

async function persistSightingUploadsFromForm(formData: FormData): Promise<SightingImageSlot[]> {
  // New gallery payload: per-slot fields with positioning
  if (formData.get(SIGHTING_GALLERY_SENTINEL)) {
    return parseSightingImageGalleryForm(formData, SIGHTING_GALLERY_FIELD_NAMES, {
      maxBytes: MAX_SIGHTING_UPLOAD_BYTES,
      // Visitors only ever send files; a pre-existing URL must be one we stored.
      allowPersistedUrl: isOwnStorageUrl,
    });
  }
  // Legacy multi-file payload (still used by the native API client)
  const raw = formData.getAll("sightingImages");
  const files = raw.filter((e): e is File => e instanceof File && e.size > 0);
  const capped = files.slice(0, 5);
  if (!capped.length) return [];
  return persistSightingFiles(capped, MAX_SIGHTING_UPLOAD_BYTES);
}

/** Side effects after the row is saved (emails, opt-in) must never change the response. */
function fireAndForget(task: () => unknown): void {
  void (async () => {
    try {
      await task();
    } catch (e) {
      console.error("[public-sighting-submit] background task failed:", e);
    }
  })();
}

/**
 * One client, one bucket: lowercase, collapse IPv6 spellings ("::1" vs
 * "0:0:0:0:0:0:0:1") and unwrap IPv4-mapped addresses ("::ffff:1.2.3.4").
 */
function canonicalizeClientIp(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "unknown";
  if (!trimmed.includes(":")) return trimmed;
  try {
    const host = new URL(`http://[${trimmed}]`).hostname.slice(1, -1);
    const mapped = host.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped?.[1]) return mapped[1];
    if (mapped?.[2] && mapped[3]) {
      const hi = Number.parseInt(mapped[2], 16);
      const lo = Number.parseInt(mapped[3], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return host;
  } catch {
    return trimmed;
  }
}

/** @returns true if this IP should be blocked (already at limit before increment semantics). */
export function isPublicSubmissionRateLimited(clientIp: string): boolean {
  const ip = canonicalizeClientIp(clientIp);
  const now = Date.now();
  const entry = _rateLimitMap.get(ip);
  if (!entry || entry.resetAt <= now) {
    _rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }
  entry.count++;
  return false;
}

/**
 * Shared (Postgres) limit first so it holds across serverless instances; the
 * per-instance limiter is the fallback when the shared store isn't available.
 */
async function isRateLimited(clientIp: string): Promise<boolean> {
  const shared = await consumeSharedRateLimit({
    key: `submit:${canonicalizeClientIp(clientIp)}`,
    max: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  return shared ?? isPublicSubmissionRateLimited(clientIp);
}

export type PublicSightingSubmitFailureCode =
  | "rate-limited"
  | "missing"
  | "no-imdb"
  | "server-error";

export type PublicSightingSubmitResult =
  | {
    ok: true;
    submissionId: string;
    catalogMatchSlug?: string;
  }
  | {
    ok: false;
    code: PublicSightingSubmitFailureCode;
    message?: string;
  };

/**
 * Parses the same multipart field names as `src/app/submit/submit-form.tsx` /
 * `submitSighting` server action.
 */
export async function executePublicSightingSubmit(
  formData: FormData,
  clientIp: string,
  options?: { skipModerationNotify?: boolean },
): Promise<PublicSightingSubmitResult> {
  try {
    if (await isRateLimited(clientIp)) {
      return { ok: false, code: "rate-limited" };
    }

    const movieTitle = cleanText(formData.get("movieTitle"), SUBMISSION_LIMITS.movieTitle);
    const imdbId = normalizeImdbId(cleanText(formData.get("imdbId"), 200));
    const movieYear = parseReleaseYear(formData.get("movieYear"));
    const imdbKindRaw = cleanText(formData.get("imdbKind"), 16).toLowerCase();
    const imdbKind = imdbKindRaw === "series" ? "series" : "movie";
    const seasonNumber =
      imdbKind === "series" ? parseSeasonOrEpisode(formData.get("seasonNumber")) : undefined;
    const episodeNumber =
      imdbKind === "series" ? parseSeasonOrEpisode(formData.get("episodeNumber")) : undefined;
    const episodeTitle =
      imdbKind === "series"
        ? cleanText(formData.get("episodeTitle"), SUBMISSION_LIMITS.episodeTitle)
        : "";
    const moviePosterUrl = sanitizePosterUrl(formData.get("moviePosterUrl"));
    const sightingTitle = cleanText(formData.get("sightingTitle"), SUBMISSION_LIMITS.sightingTitle);
    const rawTimestamp = cleanText(formData.get("timestamp"), SUBMISSION_LIMITS.timestamp);
    const timestamp = normalizeSightingTimestampInput(rawTimestamp);
    const description = cleanText(formData.get("description"), SUBMISSION_LIMITS.description);
    const submitterName = cleanText(formData.get("submitterName"), SUBMISSION_LIMITS.submitterName);
    const submitterEmail = normalizeOptionalSubmitterEmail(formData.get("submitterEmail"));
    const spoiler = formData.get("spoiler") === "on";
    const approximateRatCount = clampApproximateRatCount(formData.get("approximateRatCount"));
    const otherWarning = cleanText(formData.get("contentWarningOther"), SUBMISSION_LIMITS.contentWarning);
    const contentWarnings = cleanContentWarnings([
      ...formData.getAll("contentWarnings"),
      ...(otherWarning ? [otherWarning] : []),
    ]);
    const rodentTypes = cleanRodentTypes(formData.getAll("rodentTypes"));
    const otherRodentLabel = cleanText(
      formData.get("otherRodentLabel"),
      MAX_OTHER_RODENT_LABEL_LENGTH,
    );

    if (!movieTitle || !sightingTitle || !timestamp || !description || !submitterName) {
      return { ok: false, code: "missing" };
    }
    if (!isValidTimestamp(timestamp)) {
      return { ok: false, code: "missing", message: "Enter when the rat appears." };
    }

    if (rodentTypes.includes(OTHER_RODENT_ID) && !otherRodentLabel) {
      return {
        ok: false,
        code: "missing",
        message: "Tell us the species when choosing 'Other'.",
      };
    }

    if (!imdbId) {
      return { ok: false, code: "no-imdb" };
    }
    if (imdbKind === "series" && (!seasonNumber || !episodeNumber)) {
      return { ok: false, code: "missing", message: "Season and episode are required for shows." };
    }

    const existingMovie = await findCatalogMovieForSubmission({ imdbId, movieTitle });

    const sightingImages = await persistSightingUploadsFromForm(formData);
    const firstImage = sightingImages[0];

    const submissionRow = await addSubmission({
      movieTitle,
      movieYear,
      imdbId: imdbId || undefined,
      imdbKind,
      seasonNumber,
      episodeNumber,
      episodeTitle: episodeTitle || undefined,
      timestamp,
      title: sightingTitle,
      description,
      spoiler,
      approximateRatCount,
      submittedBy: submitterName,
      submitterEmail,
      duplicateHint: existingMovie
        ? `Potential match in catalog: ${existingMovie.title}.`
        : imdbId
          ? "No existing catalog match found."
          : "No existing catalog match found.",
      moviePosterUrl: moviePosterUrl ?? sanitizePosterUrl(existingMovie?.posterUrl),
      images: sightingImages.length ? sightingImages : undefined,
      imageUrl: firstImage?.url,
      imageAlt: firstImage?.alt,
      contentWarnings: contentWarnings.length ? contentWarnings : undefined,
      rodentTypes: rodentTypes.length ? rodentTypes : undefined,
      otherRodentLabel:
        rodentTypes.includes(OTHER_RODENT_ID) && otherRodentLabel
          ? otherRodentLabel
          : undefined,
    });

    if (!options?.skipModerationNotify) {
      fireAndForget(() => notifyOwnerOfNewSubmission(submissionRow, existingMovie?.slug));
    }
    // Ticking the opt-in box only asks us to *offer* the subscription: the receipt
    // e-mail carries a confirm link, and nothing is stored until it's clicked.
    const marketingOptIn = formData.get("marketingOptIn") === "on";
    fireAndForget(() =>
      notifySubmitterOfReceipt(submissionRow, { offerNewsOptIn: Boolean(submitterEmail) && marketingOptIn }),
    );

    return {
      ok: true,
      submissionId: submissionRow.id,
      catalogMatchSlug: existingMovie?.slug,
    };
  } catch (e) {
    // Driver errors carry hostnames and table/column names; keep them in the logs.
    console.error("[public-sighting-submit] failed:", e);
    return {
      ok: false,
      code: "server-error",
      message: "We couldn't save your submission. Please try again.",
    };
  }
}
