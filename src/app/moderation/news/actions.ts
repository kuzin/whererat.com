"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { NEWS_ITEM_TYPES } from "@/lib/news-store";
import { parsePercentValue, parseZoomValue } from "@/lib/submission-input";
import {
    createNewsItem,
    updateNewsItem,
    toggleNewsItemPublished,
    deleteNewsItem,
    getNewsItemById,
    type NewsItemType,
} from "@/lib/news-store";
import { persistImageFile } from "@/lib/media-storage";
import {
    defaultDigestSubject,
    sendDigestNewsletterToSubscribers,
    sendDigestNewsletterTest,
} from "@/lib/news-notify";

const MAX_NEWS_IMAGE_BYTES = 8 * 1024 * 1024;

/** An unknown value would hit the table's CHECK constraint and surface as a 500. */
function parseNewsType(raw: FormDataEntryValue | null): NewsItemType {
    const value = typeof raw === "string" ? raw.trim() : "";
    return NEWS_ITEM_TYPES.some((t) => t.value === value) ? (value as NewsItemType) : "announcement";
}

async function requireOwner() {
    const cookieStore = await cookies();
    const session = await verifyModeratorSession(
        cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
    );
    if (!session || session.role !== "owner") {
        redirect("/moderation");
    }
    return session;
}

export async function createNewsItemAction(formData: FormData) {
    const session = await requireOwner();
    const title = (formData.get("title") as string | null)?.trim() ?? "";
    const body = (formData.get("body") as string | null)?.trim() ?? "";
    const type = parseNewsType(formData.get("type"));
    const imageAlt = (formData.get("image_alt") as string | null)?.trim() || null;
    const publish = formData.get("publish") === "true";
    const imagePositionX = parsePercentValue(formData.get("imagePositionX"));
    const imagePositionY = parsePercentValue(formData.get("imagePositionY"));
    const imageZoom = parseZoomValue(formData.get("imageZoom"));

    // Validate before touching storage, so a rejected form can't leave an orphaned upload.
    if (!title || !body) {
        return;
    }

    const imageFile = formData.get("newsImage");
    const imageUrl = imageFile instanceof File && imageFile.size > 0
        ? (await persistImageFile(imageFile, { folder: "sightings", maxBytes: MAX_NEWS_IMAGE_BYTES })) ?? null
        : null;

    await createNewsItem({
        title,
        body,
        type,
        imageUrl,
        imageAlt,
        imagePositionX,
        imagePositionY,
        imageZoom,
        authorId: session.id,
        authorName: session.name,
        authorAvatarUrl: session.avatarUrl,
        publish,
    });

    revalidatePath("/news");
    revalidatePath("/moderation/news");
    redirect("/moderation/news?toast=news-created");
}

export async function updateNewsItemAction(formData: FormData) {
    await requireOwner();
    const id = (formData.get("id") as string | null)?.trim() ?? "";
    const title = (formData.get("title") as string | null)?.trim() ?? "";
    const body = (formData.get("body") as string | null)?.trim() ?? "";
    const type = parseNewsType(formData.get("type"));
    const imageAlt = (formData.get("image_alt") as string | null)?.trim() || null;
    const currentImageUrl = (formData.get("currentImageUrl") as string | null)?.trim() || null;
    const imagePositionX = parsePercentValue(formData.get("imagePositionX"));
    const imagePositionY = parsePercentValue(formData.get("imagePositionY"));
    const imageZoom = parseZoomValue(formData.get("imageZoom"));

    if (!id || !title || !body) {
        return;
    }

    const imageFile = formData.get("newsImage");
    const uploadedUrl = imageFile instanceof File && imageFile.size > 0
        ? (await persistImageFile(imageFile, { folder: "sightings", maxBytes: MAX_NEWS_IMAGE_BYTES })) ?? null
        : null;
    const imageUrl = uploadedUrl ?? currentImageUrl;

    await updateNewsItem(id, { title, body, type, imageUrl, imageAlt, imagePositionX, imagePositionY, imageZoom });

    revalidatePath("/news");
    revalidatePath("/moderation/news");
    redirect("/moderation/news?toast=news-updated");
}

export async function togglePublishAction(formData: FormData) {
    await requireOwner();
    const id = (formData.get("id") as string | null)?.trim() ?? "";
    const publish = formData.get("publish") === "true";
    if (!id) return;
    await toggleNewsItemPublished(id, publish);
    revalidatePath("/news");
    revalidatePath("/moderation/news");
    redirect(`/moderation/news?toast=${publish ? "news-published" : "news-unpublished"}`);
}

async function loadSelectedPublishedItems(formData: FormData) {
    const ids = formData
        .getAll("newsItemId")
        .map((v) => String(v).trim())
        .filter(Boolean);
    if (ids.length === 0) return [];
    const items = await Promise.all(ids.map((id) => getNewsItemById(id)));
    return items
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .filter((item) => item.publishedAt !== null);
}

export async function sendNewsletterDigestAction(formData: FormData) {
    const session = await requireOwner();
    const items = await loadSelectedPublishedItems(formData);
    if (items.length === 0) {
        redirect("/moderation/news?toast=newsletter-empty");
    }
    const rawSubject = String(formData.get("subject") ?? "").trim();
    const subject = rawSubject || defaultDigestSubject(items);
    const heading = String(formData.get("heading") ?? "").trim() || undefined;
    const subhead = String(formData.get("subhead") ?? "").trim() || undefined;
    const result = await sendDigestNewsletterToSubscribers(
        items,
        { id: session.id, name: session.name },
        subject,
        heading,
        subhead,
    );
    if (result.recipientCount === 0) {
        redirect("/moderation/news?toast=newsletter-no-subscribers");
    }
    revalidatePath("/moderation/news");
    redirect(`/moderation/news?toast=newsletter-sent&count=${result.recipientCount}`);
}

export async function sendNewsletterDigestTestAction(formData: FormData) {
    const session = await requireOwner();
    const items = await loadSelectedPublishedItems(formData);
    if (items.length === 0) {
        redirect("/moderation/news?toast=newsletter-empty");
    }
    const rawSubject = String(formData.get("subject") ?? "").trim();
    const subject = rawSubject || defaultDigestSubject(items);
    const heading = String(formData.get("heading") ?? "").trim() || undefined;
    const subhead = String(formData.get("subhead") ?? "").trim() || undefined;
    await sendDigestNewsletterTest(items, session.email, subject, heading, subhead);
    redirect("/moderation/news?toast=newsletter-test-sent&compose=1");
}

export async function deleteNewsItemAction(formData: FormData) {
    await requireOwner();
    const id = (formData.get("id") as string | null)?.trim() ?? "";
    if (!id) return;
    await deleteNewsItem(id);
    revalidatePath("/news");
    revalidatePath("/moderation/news");
    redirect("/moderation/news?toast=news-deleted");
}
