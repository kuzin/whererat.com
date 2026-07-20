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
import { getCatalogMovieByImdbId, getCatalogMovieByExactTitle } from "@/lib/movie-catalog";
import {
  persistSightingFiles,
  parseSightingImageGalleryForm,
  SIGHTING_GALLERY_FIELD_NAMES,
  SIGHTING_GALLERY_SENTINEL,
} from "@/lib/media-storage";
import { notifyOwnerOfNewSubmission } from "@/lib/moderation-notify";
import { notifySubmitterOfReceipt } from "@/lib/submitter-notify";
import { upsertMarketingOptIn } from "@/lib/email-preferences-store";

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
    });
  }
  // Legacy multi-file payload (still used by the native API client)
  const raw = formData.getAll("sightingImages");
  const files = raw.filter((e): e is File => e instanceof File && e.size > 0);
  const capped = files.slice(0, 5);
  if (!capped.length) return [];
  return persistSightingFiles(capped, MAX_SIGHTING_UPLOAD_BYTES);
}

/** @returns true if this IP should be blocked (already at limit before increment semantics). */
export function isPublicSubmissionRateLimited(clientIp: string): boolean {
  const ip = clientIp.trim() || "unknown";
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
    if (isPublicSubmissionRateLimited(clientIp)) {
      return { ok: false, code: "rate-limited" };
    }

    const selectedMovieTitle = String(formData.get("movieTitle") ?? "").trim();
    const movieTitle = selectedMovieTitle;
    const imdbId = normalizeImdbId(String(formData.get("imdbId") ?? ""));
    const movieYear = Number(formData.get("movieYear") || "");
    const imdbKindRaw = String(formData.get("imdbKind") ?? "").trim().toLowerCase();
    const imdbKind = imdbKindRaw === "series" ? "series" : "movie";
    const seasonNumberRaw = Number.parseInt(String(formData.get("seasonNumber") ?? "").trim(), 10);
    const episodeNumberRaw = Number.parseInt(String(formData.get("episodeNumber") ?? "").trim(), 10);
    const episodeTitle = String(formData.get("episodeTitle") ?? "").trim();
    const moviePosterUrl = String(formData.get("moviePosterUrl") || "").trim();
    const sightingTitle = String(formData.get("sightingTitle") ?? "").trim();
    const timestamp = normalizeSightingTimestampInput(String(formData.get("timestamp") ?? ""));
    const description = String(formData.get("description") ?? "").trim();
    const submitterName = String(formData.get("submitterName") ?? "").trim();
    const submitterEmail = normalizeOptionalSubmitterEmail(formData.get("submitterEmail"));
    const spoiler = formData.get("spoiler") === "on";
    const approximateRatCount = clampApproximateRatCount(formData.get("approximateRatCount"));
    const contentWarnings = formData.getAll("contentWarnings")
      .map((v) => String(v).trim())
      .filter(Boolean);
    const rodentTypes = formData.getAll("rodentTypes")
      .map((v) => String(v).trim())
      .filter(Boolean);
    const otherRodentLabel = String(formData.get("otherRodentLabel") ?? "")
      .trim()
      .slice(0, MAX_OTHER_RODENT_LABEL_LENGTH);
    const otherWarning = String(formData.get("contentWarningOther") ?? "").trim().slice(0, 200);
    if (otherWarning) contentWarnings.push(otherWarning);

    if (!movieTitle || !sightingTitle || !timestamp || !description || !submitterName) {
      return { ok: false, code: "missing" };
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
    const seasonNumber =
      imdbKind === "series" && Number.isFinite(seasonNumberRaw) && seasonNumberRaw >= 1
        ? seasonNumberRaw
        : undefined;
    const episodeNumber =
      imdbKind === "series" && Number.isFinite(episodeNumberRaw) && episodeNumberRaw >= 1
        ? episodeNumberRaw
        : undefined;
    if (imdbKind === "series" && (!seasonNumber || !episodeNumber)) {
      return { ok: false, code: "missing", message: "Season and episode are required for shows." };
    }

    const existingMovie =
      (imdbId ? await getCatalogMovieByImdbId(imdbId) : undefined) ??
      (await getCatalogMovieByExactTitle(movieTitle));

    const sightingImages = await persistSightingUploadsFromForm(formData);
    const firstImage = sightingImages[0];

    const submissionRow = await addSubmission({
      movieTitle,
      movieYear: Number.isFinite(movieYear) ? movieYear : undefined,
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
      moviePosterUrl: moviePosterUrl || existingMovie?.posterUrl || undefined,
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
      void notifyOwnerOfNewSubmission(submissionRow, existingMovie?.slug);
    }
    void notifySubmitterOfReceipt(submissionRow);

    const marketingOptIn = formData.get("marketingOptIn") === "on";
    if (submitterEmail && marketingOptIn) {
      void upsertMarketingOptIn(submitterEmail).catch(() => { });
    }

    return {
      ok: true,
      submissionId: submissionRow.id,
      catalogMatchSlug: existingMovie?.slug,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, code: "server-error", message };
  }
}
