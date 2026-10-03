"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  MODERATOR_SESSION_COOKIE,
  parseModeratorSession,
} from "@/lib/auth";
import { deleteSubmissionById, reviewSubmission } from "@/lib/moderation-store";
import { parseMovieIdentityEdits } from "@/lib/movie-identity-form";
import {
  clampApproximateRatCount,
  normalizeSightingTimestampInput,
  type ImdbTitleKind,
  type SightingImageSlot,
} from "@/lib/whererat";
import {
  persistSightingFiles,
  parseSightingImageGalleryForm,
  SIGHTING_GALLERY_FIELD_NAMES,
  SIGHTING_GALLERY_SENTINEL,
} from "@/lib/media-storage";
import { resyncAllCatalogMoviesFromImdb } from "@/lib/movie-imdb-sync";
import { createStoredModerator, updateUserByOwner } from "@/lib/user-store";
import { persistImageFile } from "@/lib/media-storage";

const MAX_SIGHTING_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;

async function getModeratorOrRedirect() {
  const cookieStore = await cookies();
  const session = parseModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );

  if (!session) {
    redirect("/login?next=/moderation");
  }

  return session;
}

async function persistSightingUploads(formData: FormData): Promise<SightingImageSlot[]> {
  const raw = formData.getAll("sightingImages");
  const files = raw.filter((e): e is File => e instanceof File && e.size > 0);
  const capped = files.slice(0, 5);
  if (!capped.length) return [];
  return persistSightingFiles(capped, MAX_SIGHTING_UPLOAD_BYTES);
}

export async function moderateSubmission(formData: FormData) {
  const moderator = await getModeratorOrRedirect();
  const submissionId = String(formData.get("submissionId") ?? "");
  const decision = String(formData.get("decision") ?? "") as
    | "approved"
    | "edited"
    | "edited and approved"
    | "rejected";
  const reason = String(formData.get("reason") ?? "").trim();
  const curatorNote = String(formData.get("curatorNote") ?? "").trim();
  const imdbKindRaw = String(formData.get("imdbKind") ?? "").trim().toLowerCase();
  const imdbKind: ImdbTitleKind = imdbKindRaw === "series" ? "series" : "movie";
  const seasonNumberRaw = Number.parseInt(String(formData.get("seasonNumber") ?? "").trim(), 10);
  const episodeNumberRaw = Number.parseInt(String(formData.get("episodeNumber") ?? "").trim(), 10);
  const episodeTitle = String(formData.get("episodeTitle") ?? "").trim();
  const galleryManaged = Boolean(formData.get(SIGHTING_GALLERY_SENTINEL));
  const legacyListManaged = String(formData.get("imageListManaged") ?? "") === "1";
  let nextImages: SightingImageSlot[] = [];
  if (galleryManaged) {
    nextImages = await parseSightingImageGalleryForm(
      formData,
      SIGHTING_GALLERY_FIELD_NAMES,
    );
  } else if (legacyListManaged) {
    const finalImageAlts = formData
      .getAll("finalImageAlt")
      .map((value) => String(value ?? "").trim());
    nextImages = formData
      .getAll("finalImageUrl")
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .map((url, index) => ({
        url,
        alt: finalImageAlts[index] || undefined,
      }))
      .slice(0, 5);
  } else {
    const existingImageUrls = formData
      .getAll("existingImageUrl")
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    const existingImageAlts = formData
      .getAll("existingImageAlt")
      .map((value) => String(value ?? "").trim());
    const removeExistingImageUrls = new Set(
      formData
        .getAll("removeExistingImageUrl")
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    );
    const keptExistingImages: SightingImageSlot[] = existingImageUrls
      .map((url, index) => ({
        url,
        alt: existingImageAlts[index] || undefined,
      }))
      .filter((slot) => !removeExistingImageUrls.has(slot.url));
    const uploadedImages = await persistSightingUploads(formData);
    nextImages = [...keptExistingImages, ...uploadedImages].slice(0, 5);
  }
  const leadImage = nextImages[0];

  if (!submissionId || !decision) {
    return;
  }

  const contentWarnings = formData.getAll("contentWarnings").map((v) => String(v).trim()).filter(Boolean);
  const otherWarning = String(formData.get("contentWarningOther") ?? "").trim().slice(0, 200);
  if (otherWarning) contentWarnings.push(otherWarning);
  const rodentTypes = formData.getAll("rodentTypes").map((v) => String(v).trim()).filter(Boolean);
  const otherRodentLabel = String(formData.get("otherRodentLabel") ?? "").trim().slice(0, 60);

  const movieIdentity = parseMovieIdentityEdits(formData);
  if (!movieIdentity.ok) {
    redirect(`/moderation?toast=invalid-movie&edit=${encodeURIComponent(submissionId)}`);
  }

  const hasEditFields =
    formData.has("sightingTitle") ||
    formData.has("imdbKind") ||
    formData.has("seasonNumber") ||
    formData.has("episodeNumber") ||
    formData.has("episodeTitle") ||
    formData.has("timestamp") ||
    formData.has("description") ||
    formData.has("approximateRatCount") ||
    formData.has(SIGHTING_GALLERY_SENTINEL) ||
    formData.has("imageListManaged") ||
    formData.has("existingImageUrl") ||
    formData.has("sightingImages");
  const edits = hasEditFields
    ? {
      ...movieIdentity.edits,
      title: String(formData.get("sightingTitle") ?? "").trim(),
      imdbKind,
      seasonNumber:
        imdbKind === "series" && Number.isFinite(seasonNumberRaw) && seasonNumberRaw >= 1
          ? seasonNumberRaw
          : undefined,
      episodeNumber:
        imdbKind === "series" && Number.isFinite(episodeNumberRaw) && episodeNumberRaw >= 1
          ? episodeNumberRaw
          : undefined,
      episodeTitle: imdbKind === "series" ? episodeTitle || undefined : undefined,
      timestamp: normalizeSightingTimestampInput(
        String(formData.get("timestamp") ?? ""),
      ),
      description: String(formData.get("description") ?? "").trim(),
      spoiler: formData.get("spoiler") === "on",
      approximateRatCount: clampApproximateRatCount(
        formData.get("approximateRatCount"),
      ),
      images: nextImages,
      imageUrl: leadImage?.url,
      imageAlt: leadImage?.alt,
      curatorNote: curatorNote || undefined,
      contentWarnings: contentWarnings.length ? contentWarnings : undefined,
      rodentTypes: rodentTypes.length ? rodentTypes : undefined,
      otherRodentLabel:
        rodentTypes.includes("other") && otherRodentLabel ? otherRodentLabel : undefined,
    }
    : curatorNote
      ? { curatorNote }
      : undefined;

  if (decision === "edited and approved") {
    await reviewSubmission({
      submissionId,
      decision,
      moderator,
      reason: reason || "Edited by moderator before approval.",
      edits,
    });
    revalidatePath("/moderation");
    redirect("/moderation?toast=moderation-approved");
  }

  if (decision === "edited") {
    await reviewSubmission({
      submissionId,
      decision,
      moderator,
      reason: reason || "Saved edits in moderation modal.",
      edits,
    });
    revalidatePath("/moderation");
    redirect("/moderation?toast=moderation-saved");
  }

  await reviewSubmission({
    submissionId,
    decision,
    moderator,
    reason:
      decision === "rejected"
        ? reason || "Rejected from moderation queue."
        : reason,
    edits,
  });
  revalidatePath("/moderation");
  if (decision === "approved") {
    redirect("/moderation?toast=moderation-approved");
  }
  if (decision === "rejected") {
    redirect("/moderation?toast=moderation-rejected");
  }
}

export async function removeSubmission(formData: FormData) {
  await getModeratorOrRedirect();
  const submissionId = String(formData.get("submissionId") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "").trim() || "/moderation";
  if (!submissionId) {
    redirect(returnTo);
  }
  await deleteSubmissionById(submissionId);
  revalidatePath("/moderation");
  const returnToWithToast = returnTo.includes("?")
    ? `${returnTo}&toast=deleted`
    : `${returnTo}?toast=deleted`;
  redirect(returnToWithToast);
}

export async function resyncAllMovies() {
  const session = await getModeratorOrRedirect();

  if (session.role !== "owner") {
    redirect("/moderation?toast=error");
  }

  const { synced, errors } = await resyncAllCatalogMoviesFromImdb();

  revalidatePath("/");
  revalidatePath("/movies/[slug]", "layout");
  revalidatePath("/shows/[slug]", "layout");
  revalidatePath("/moderation");

  const params = new URLSearchParams();
  params.set("toast", "resync-all-complete");
  params.set("synced", String(synced));
  if (errors > 0) params.set("errors", String(errors));

  redirect(`/moderation?${params.toString()}`);
}

export async function rereviewSubmission(formData: FormData) {
  const moderator = await getModeratorOrRedirect();
  const submissionId = String(formData.get("submissionId") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "").trim() || "/moderation";
  if (!submissionId) {
    redirect(returnTo);
  }
  await reviewSubmission({
    submissionId,
    decision: "edited",
    moderator,
    reason: "Returned to pending queue for re-review.",
  });
  revalidatePath("/moderation");
  const requeuedReturnTo = returnTo.includes("?")
    ? `${returnTo}&toast=moderation-requeued`
    : `${returnTo}?toast=moderation-requeued`;
  redirect(requeuedReturnTo);
}

export async function createModerator(formData: FormData) {
  const session = await getModeratorOrRedirect();

  if (session.role !== "owner") {
    redirect("/moderation");
  }

  const username = String(formData.get("newUsername") ?? "").trim().toLowerCase();
  const name = String(formData.get("newName") ?? "").trim();
  const email = String(formData.get("newEmail") ?? "").trim();
  const password = String(formData.get("newPassword") ?? "").trim();
  const role = String(formData.get("newRole") ?? "") === "owner" ? "owner" : "moderator";

  if (!username || !name || !email || !password) {
    redirect("/moderation?addUser=missing");
  }

  if (password.length < 6) {
    redirect("/moderation?addUser=weak_password");
  }

  const result = await createStoredModerator({ username, name, email, password, role });

  if (!result.success) {
    redirect(`/moderation?addUser=${result.error}`);
  }

  revalidatePath("/moderation");
  redirect("/moderation?toast=user-created");
}

export async function updateUserAsOwner(formData: FormData) {
  const session = await getModeratorOrRedirect();

  if (session.role !== "owner") {
    redirect("/moderation");
  }

  const userId = String(formData.get("editUserId") ?? "").trim();
  const name = String(formData.get("editName") ?? "").trim();
  const email = String(formData.get("editEmail") ?? "").trim();
  const role = String(formData.get("editRole") ?? "") === "owner" ? "owner" : "moderator";
  const newPassword = String(formData.get("editPassword") ?? "").trim();
  const currentAvatarUrl = String(formData.get("currentAvatarUrl") ?? "").trim();

  const avatarFile = formData.get("avatarImage");
  const uploadedAvatarUrl =
    avatarFile instanceof File && avatarFile.size > 0
      ? await persistImageFile(avatarFile, { folder: "avatars", maxBytes: MAX_AVATAR_UPLOAD_BYTES })
      : undefined;
  const avatarUrl = uploadedAvatarUrl ?? (currentAvatarUrl || undefined);

  if (!userId || !name || !email) {
    redirect("/moderation?editUser=missing");
  }

  if (newPassword && newPassword.length < 6) {
    redirect("/moderation?editUser=weak_password");
  }

  const result = await updateUserByOwner({
    userId,
    name,
    email,
    role,
    avatarUrl,
    newPassword: newPassword || undefined,
  });

  if (!result.success) {
    redirect(`/moderation?editUser=${result.error}`);
  }

  revalidatePath("/moderation");
  redirect("/moderation?toast=user-updated");
}
