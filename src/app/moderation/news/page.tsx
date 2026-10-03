import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { getAllNewsItems, getNewsItemById, NEWS_ITEM_TYPES, type NewsItem } from "@/lib/news-store";
import { getSentNewsItemIds } from "@/lib/newsletter-sends-store";
import { NewsBodyEditor } from "@/components/forms/news-body-editor";
import { ModalShell } from "@/components/ui/modal-shell";
import { NewsImageUpload } from "@/components/forms/news-image-upload";
import { ComposeNewsletterModal } from "./compose-newsletter-modal";
import { ActionMenuRow, type Action } from "@/components/ui/action-menu-row";
import { PageHeader } from "@/components/layout/page-header";
import {
    createNewsItemAction,
    updateNewsItemAction,
    togglePublishAction,
    deleteNewsItemAction,
} from "./actions";

export const metadata: Metadata = {
    title: "Manage News",
    robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(v: string | string[] | undefined) {
    return Array.isArray(v) ? v[0] : v;
}

const TYPE_COLORS: Record<string, string> = {
    announcement: "bg-blue-100 text-blue-800 border-blue-300/60 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500/30",
    "product-news": "bg-violet-100 text-violet-800 border-violet-300/60 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-500/30",
    community: "bg-emerald-100 text-emerald-800 border-emerald-300/60 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-500/30",
    update: "bg-stone-100 text-stone-700 border-stone-300/60 dark:bg-stone-800/60 dark:text-stone-300 dark:border-stone-600/40",
};

function TypeBadge({ type }: { type: string }) {
    const label = NEWS_ITEM_TYPES.find((t) => t.value === type)?.label ?? type;
    const colorClass = TYPE_COLORS[type] ?? TYPE_COLORS.update;
    return (
        <span className={`inline-flex rounded-lg border px-2.5 py-1 text-xs font-semibold leading-none shadow-[1px_1px_0_0_rgb(28_25_23/0.10)] dark:shadow-[1px_1px_0_0_rgb(0_0_0/0.35)] ${colorClass}`}>
            {label}
        </span>
    );
}

const EditIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
);

const EyeIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const EyeOffIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

const TrashIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4h6v2" />
    </svg>
);

const LinkChainIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
);

const MailIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
);

const ExternalIcon = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
);

const PlusIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

function buildNewsRowActions(item: NewsItem): Action[] {
    const actions: Action[] = [];
    if (item.publishedAt) {
        actions.push({
            kind: "copy",
            key: "copy",
            label: "Copy direct link",
            icon: LinkChainIcon,
            url: `/news?post=${item.id}`,
        });
    }
    actions.push({
        kind: "link",
        key: "edit",
        label: "Edit",
        icon: EditIcon,
        href: `/moderation/news?edit=${item.id}`,
    });
    actions.push({
        kind: "form",
        key: "toggle",
        label: item.publishedAt ? "Unpublish" : "Publish",
        icon: item.publishedAt ? EyeOffIcon : EyeIcon,
        formAction: togglePublishAction,
        hidden: { id: item.id, publish: item.publishedAt ? "false" : "true" },
    });
    actions.push({
        kind: "confirm-form",
        key: "delete",
        label: "Delete",
        icon: TrashIcon,
        formAction: deleteNewsItemAction,
        hidden: { id: item.id },
        confirmMessage: `Permanently delete "${item.title}"? This cannot be undone.`,
        danger: true,
    });
    return actions;
}


function NewsFormFields({ item, showPublishToggle }: { item?: NewsItem; showPublishToggle?: boolean }) {
    return (
        <>
            {item && <input type="hidden" name="id" value={item.id} />}

            <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                    <span className="text-sm font-bold text-stone-700 dark:text-stone-200">Title</span>
                    <input
                        name="title"
                        type="text"
                        required
                        defaultValue={item?.title ?? ""}
                        placeholder="Post title"
                        className="wr-input"
                    />
                </label>

                <label className="flex flex-col gap-1.5 sm:col-span-2">
                    <span className="text-sm font-bold text-stone-700 dark:text-stone-200">Type</span>
                    <select name="type" defaultValue={item?.type ?? "announcement"} className="wr-select">
                        {NEWS_ITEM_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                </label>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <NewsImageUpload
                        initialImageUrl={item?.imageUrl ?? undefined}
                        initialPositionX={item?.imagePositionX}
                        initialPositionY={item?.imagePositionY}
                        initialZoom={item?.imageZoom}
                    />
                </div>

                <label className="flex flex-col gap-1.5 sm:col-span-2">
                    <span className="flex items-baseline gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                        Image alt text
                        <span className="text-xs font-medium text-stone-400 dark:text-stone-500">Optional</span>
                    </span>
                    <input
                        name="image_alt"
                        type="text"
                        defaultValue={item?.imageAlt ?? ""}
                        placeholder="Describe the image for screen readers"
                        className="wr-input"
                    />
                </label>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <span className="text-sm font-bold text-stone-700 dark:text-stone-200">Body</span>
                    <NewsBodyEditor defaultValue={item?.body} />
                </div>
            </div>

            {showPublishToggle && (
                <label className="group mt-1 flex cursor-pointer select-none items-center gap-3 text-sm font-semibold text-stone-700 dark:text-stone-200">
                    <input type="checkbox" name="publish" value="true" className="peer sr-only" />
                    <span className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-stone-300 bg-stone-200 transition-colors peer-checked:border-orange-500 peer-checked:bg-orange-500 peer-focus-visible:ring-2 peer-focus-visible:ring-orange-500/50 peer-focus-visible:ring-offset-1 dark:border-stone-600 dark:bg-stone-700 dark:peer-checked:border-orange-500 dark:peer-checked:bg-orange-500">
                        <span className="absolute left-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform group-has-[input:checked]:translate-x-4 dark:bg-stone-300 dark:group-has-[input:checked]:bg-white" />
                    </span>
                    Publish immediately
                </label>
            )}
        </>
    );
}

export default async function ManageNewsPage({
    searchParams,
}: {
    searchParams?: SearchParams;
}) {
    const cookieStore = await cookies();
    const session = await verifyModeratorSession(
        cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
    );

    if (!session) redirect("/login?next=/moderation/news");
    if (session.role !== "owner") redirect("/moderation");

    const params = searchParams ? await searchParams : {};
    const editingId = single(params.edit);
    const isCreating = single(params.create) === "1";
    const isComposing = single(params.compose) === "1";
    const editingItem = editingId ? await getNewsItemById(editingId) : undefined;

    const allItems = await getAllNewsItems();
    const sentIds = isComposing ? await getSentNewsItemIds() : new Set<string>();
    const composeItems = isComposing
        ? allItems
            .filter((item) => item.publishedAt !== null)
            .map((item) => ({
                id: item.id,
                title: item.title,
                type: NEWS_ITEM_TYPES.find((t) => t.value === item.type)?.label ?? item.type,
                publishedAt: (item.publishedAt as Date).toISOString(),
                alreadySent: sentIds.has(item.id),
            }))
        : [];

    return (
        <main className="wr-page-shell py-10">
            <PageHeader
                back={{ href: "/moderation", label: "Moderation" }}
                title="Manage News"
                actions={[
                    {
                        kind: "link",
                        key: "compose",
                        label: "Compose newsletter",
                        icon: MailIcon,
                        href: "/moderation/news?compose=1",
                    },
                    {
                        kind: "link",
                        key: "view",
                        label: "View /news",
                        icon: ExternalIcon,
                        href: "/news",
                    },
                ]}
                primaryAction={{
                    href: "/moderation/news?create=1",
                    label: "New Post",
                    icon: PlusIcon,
                }}
            />

            {/* All posts list */}
            <section>
                <h2 className="mb-4 text-lg font-black text-stone-950 dark:text-stone-100">
                    All posts{" "}
                    <span className="text-base font-semibold text-stone-400 dark:text-stone-500">
                        ({allItems.length})
                    </span>
                </h2>

                {allItems.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-stone-300 p-10 text-center text-stone-500 dark:border-stone-700 dark:text-stone-400">
                        No posts yet. Use the &ldquo;New post&rdquo; button above to create one.
                    </p>
                ) : (
                    <div className="divide-y divide-stone-900/10 rounded-2xl border border-stone-900/12 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-900/70">
                        {allItems.map((item) => (
                            <div
                                key={item.id}
                                className="flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5"
                            >
                                {/* Content */}
                                <div className="min-w-0 flex-1">
                                    {item.publishedAt ? (
                                        <Link href={`/news?post=${item.id}`} className="font-bold text-stone-950 hover:underline dark:text-stone-100">
                                            {item.title}
                                        </Link>
                                    ) : (
                                        <p className="font-bold text-stone-950 dark:text-stone-100">{item.title}</p>
                                    )}
                                    <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                                        {item.authorName} ·{" "}
                                        {item.publishedAt
                                            ? `Published ${item.publishedAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`
                                            : `Created ${item.createdAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`}
                                    </p>
                                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                        <TypeBadge type={item.type} />
                                        {item.publishedAt ? (
                                            <span className="inline-flex rounded-lg border border-green-400/60 bg-green-50 px-2.5 py-1 text-xs font-semibold leading-none text-green-800 shadow-[1px_1px_0_0_rgb(28_25_23/0.10)] dark:border-green-600/30 dark:bg-green-950/20 dark:text-green-400 dark:shadow-[1px_1px_0_0_rgb(0_0_0/0.35)]">
                                                Published
                                            </span>
                                        ) : (
                                            <span className="inline-flex rounded-lg border border-stone-300 bg-stone-100 px-2.5 py-1 text-xs font-semibold leading-none text-stone-500 shadow-[1px_1px_0_0_rgb(28_25_23/0.10)] dark:border-white/15 dark:bg-stone-800 dark:text-stone-400 dark:shadow-[1px_1px_0_0_rgb(0_0_0/0.35)]">
                                                Draft
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Icon action buttons (collapses to overflow when > 2) */}
                                <ActionMenuRow
                                    className="justify-end"
                                    actions={buildNewsRowActions(item)}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Create modal */}
            {isCreating && (
                <ModalShell
                    title="New post"
                    closeHref="/moderation/news"
                    footer={
                        <>
                            <label className="group mr-auto flex cursor-pointer select-none items-center gap-3 text-sm font-semibold text-stone-700 dark:text-stone-200">
                                <input form="news-create-form" type="checkbox" name="publish" value="true" className="peer sr-only" />
                                <span className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-stone-300 bg-stone-200 transition-colors peer-checked:border-orange-500 peer-checked:bg-orange-500 peer-focus-visible:ring-2 peer-focus-visible:ring-orange-500/50 peer-focus-visible:ring-offset-1 dark:border-stone-600 dark:bg-stone-700 dark:peer-checked:border-orange-500 dark:peer-checked:bg-orange-500">
                                    <span className="absolute left-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform group-has-[input:checked]:translate-x-4 dark:bg-stone-300 dark:group-has-[input:checked]:bg-white" />
                                </span>
                                Publish immediately
                            </label>
                            <Link href="/moderation/news" className="wr-btn-ghost">
                                Cancel
                            </Link>
                            <button form="news-create-form" type="submit" className="wr-btn-primary">
                                Create post
                            </button>
                        </>
                    }
                >
                    <form id="news-create-form" action={createNewsItemAction} className="py-5 grid gap-4">
                        <NewsFormFields />
                    </form>
                </ModalShell>
            )}

            {/* Compose newsletter modal */}
            {isComposing && (
                <ComposeNewsletterModal
                    items={composeItems}
                    moderatorEmail={session.email}
                    initialShowAlreadySent={false}
                />
            )}

            {/* Edit modal */}
            {editingItem && (
                <ModalShell
                    title={`Edit: ${editingItem.title}`}
                    closeHref="/moderation/news"
                    footer={
                        <>
                            <Link href="/moderation/news" className="wr-btn-ghost">
                                Cancel
                            </Link>
                            <button form="news-edit-form" type="submit" className="wr-btn-primary">
                                Save changes
                            </button>
                        </>
                    }
                >
                    <form id="news-edit-form" action={updateNewsItemAction} className="py-5 grid gap-4">
                        <NewsFormFields item={editingItem} />
                    </form>
                </ModalShell>
            )}
        </main>
    );
}
