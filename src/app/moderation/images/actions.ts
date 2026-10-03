"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { getAllMergedSightings } from "@/lib/moderation-store";
import { replaceSightingImages } from "@/lib/sighting-edit-store";
import { parseSightingImageGalleryForm, SIGHTING_GALLERY_FIELD_NAMES } from "@/lib/media-storage";
import { getMoviePath, getSightingImageRefs } from "@/lib/whererat";
import {
  parseSightingImageFilter,
  parseSightingImagesPage,
  parseSightingImagesQuery,
  sightingImagesPath,
} from "@/lib/sighting-images-view";

/**
 * Saves the image carousel of one live sighting from /moderation/images. Only the
 * images change: no review action is logged and the submitter is not e-mailed.
 */
export async function saveSightingImages(formData: FormData) {
  const cookieStore = await cookies();
  const session = await verifyModeratorSession(cookieStore.get(MODERATOR_SESSION_COOKIE)?.value);
  if (!session) redirect("/login?next=/moderation/images");

  // The list the moderator came from, rebuilt from its parts so no free-form URL is followed.
  const list = {
    filter: parseSightingImageFilter(formData.get("filter")),
    q: parseSightingImagesQuery(formData.get("q")),
    page: parseSightingImagesPage(formData.get("page")),
  };
  const sightingId = String(formData.get("sightingId") ?? "").trim();
  const nextSightingId = String(formData.get("nextSightingId") ?? "").trim();
  const advance = formData.get("intent") === "next" && nextSightingId !== "";

  const entry = sightingId
    ? (await getAllMergedSightings()).find((item) => item.sighting.id === sightingId)
    : undefined;
  if (!entry) redirect(sightingImagesPath({ ...list, toast: "sighting-images-missing" }));

  // Kept images come back by URL; only ones this sighting already has are accepted,
  // anything new has to arrive as an upload.
  const currentUrls = new Set(getSightingImageRefs(entry.sighting).map((slot) => slot.url));
  const images = await parseSightingImageGalleryForm(formData, SIGHTING_GALLERY_FIELD_NAMES, {
    allowPersistedUrl: (url) => currentUrls.has(url),
  });

  if (!(await replaceSightingImages(sightingId, images))) {
    redirect(sightingImagesPath({ ...list, toast: "sighting-images-missing" }));
  }

  revalidatePath(getMoviePath(entry.movie));
  revalidatePath("/moderation");
  revalidatePath("/moderation/images");
  redirect(
    advance
      ? sightingImagesPath({ filter: list.filter, q: list.q, edit: nextSightingId, toast: "sighting-images-saved" })
      : sightingImagesPath({ ...list, toast: "sighting-images-saved" }),
  );
}
