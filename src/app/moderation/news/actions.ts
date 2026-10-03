"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
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
    const type = ((formData.get("type") as string | null) ?? "announcement") as NewsItemType;
    const imageAlt = (formData.get("image_alt") as string | null)?.trim() || null;
    const publish = formData.get("publish") === "true";
    const imagePositionX = parseFloat((formData.get("imagePositionX") as string | null) ?? "50") || 50;
    const imagePositionY = parseFloat((formData.get("imagePositionY") as string | null) ?? "50") || 50;
    const imageZoom = Math.max(1, parseFloat((formData.get("imageZoom") as string | null) ?? "1") || 1);

    const imageFile = formData.get("newsImage");
    const imageUrl = imageFile instanceof File && imageFile.size > 0
        ? (await persistImageFile(imageFile, { folder: "sightings", maxBytes: MAX_NEWS_IMAGE_BYTES })) ?? null
        : null;

    if (!title || !body) {
        return;
    }

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
    const type = ((formData.get("type") as string | null) ?? "announcement") as NewsItemType;
    const imageAlt = (formData.get("image_alt") as string | null)?.trim() || null;
    const currentImageUrl = (formData.get("currentImageUrl") as string | null)?.trim() || null;
    const imagePositionX = parseFloat((formData.get("imagePositionX") as string | null) ?? "50") || 50;
    const imagePositionY = parseFloat((formData.get("imagePositionY") as string | null) ?? "50") || 50;
    const imageZoom = Math.max(1, parseFloat((formData.get("imageZoom") as string | null) ?? "1") || 1);

    const imageFile = formData.get("newsImage");
    const uploadedUrl = imageFile instanceof File && imageFile.size > 0
        ? (await persistImageFile(imageFile, { folder: "sightings", maxBytes: MAX_NEWS_IMAGE_BYTES })) ?? null
        : null;
    const imageUrl = uploadedUrl ?? currentImageUrl;

    if (!id || !title || !body) {
        return;
    }

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
