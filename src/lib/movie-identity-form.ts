import { SUBMISSION_LIMITS, cleanText } from "@/lib/submission-input";
import { normalizeImdbId, type Submission } from "@/lib/whererat";

type MovieIdentityEdits = Partial<Pick<Submission, "movieTitle" | "imdbId">>;

/**
 * Reads the optional "which title is this sighting for" fields from a moderator
 * edit form. Fields that aren't in the form are left out of the edits, so forms
 * that don't render them (e.g. a non-queue sighting) leave the title untouched.
 */
export function parseMovieIdentityEdits(
  formData: FormData,
): { ok: true; edits: MovieIdentityEdits } | { ok: false } {
  const edits: MovieIdentityEdits = {};

  if (formData.has("movieTitle")) {
    const movieTitle = cleanText(formData.get("movieTitle"), SUBMISSION_LIMITS.movieTitle);
    if (!movieTitle) return { ok: false };
    edits.movieTitle = movieTitle;
  }

  if (formData.has("imdbId")) {
    const raw = cleanText(formData.get("imdbId"), 200);
    const imdbId = normalizeImdbId(raw);
    if (!imdbId) return { ok: false };
    edits.imdbId = imdbId;
  }

  return { ok: true, edits };
}
