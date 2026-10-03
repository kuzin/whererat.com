import Image from "next/image";
import { SightingMarkdown } from "@/components/ui/sighting-markdown";
import type { NewsItem, NewsItemType } from "@/lib/news-store";

const NEWS_TYPE_LABELS: Record<NewsItemType, string> = {
    announcement: "Announcement",
    "product-news": "Product news",
    community: "Community",
    update: "Update",
};

export const TYPE_STYLES: Record<NewsItemType, { chip: string; dot: string }> = {
    announcement: {
        chip: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/40",
        dot: "bg-blue-500 dark:bg-blue-400",
    },
    "product-news": {
        chip: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-700/40",
        dot: "bg-violet-500 dark:bg-violet-400",
    },
    community: {
        chip: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40",
        dot: "bg-emerald-500 dark:bg-emerald-400",
    },
    update: {
        chip: "bg-stone-100 text-stone-700 border-stone-200 dark:bg-stone-800/60 dark:text-stone-300 dark:border-stone-600/40",
        dot: "bg-stone-400 dark:bg-stone-500",
    },
};

function typeLabel(type: NewsItemType) {
    return NEWS_TYPE_LABELS[type] ?? type;
}

export function TypeChip({ type }: { type: NewsItemType }) {
    const style = TYPE_STYLES[type] ?? TYPE_STYLES.update;
    return (
        <span className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-bold uppercase tracking-[0.1em] ${style.chip}`}>
            {typeLabel(type)}
        </span>
    );
}

export function ArticleView({
    item,
    titleAs: Title = "h1",
}: {
    item: NewsItem;
    titleAs?: "h1" | "h2";
}) {
    const pubDate = item.publishedAt!;
    const formattedDate = pubDate.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });

    return (
        <article>
            {item.imageUrl && (
                <div className="relative mb-8 aspect-[5/3] w-full overflow-hidden rounded-2xl sm:aspect-[5/2]">
                    <Image
                        src={item.imageUrl}
                        alt={item.imageAlt ?? ""}
                        fill
                        className="object-cover"
                        style={{
                            objectPosition: `${item.imagePositionX}% ${item.imagePositionY}%`,
                            ...(item.imageZoom !== 1 && {
                                transform: `scale(${item.imageZoom})`,
                                transformOrigin: `${item.imagePositionX}% ${item.imagePositionY}%`,
                            }),
                        }}
                        sizes="(max-width: 1024px) 100vw, 700px"
                        priority
                    />
                </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
                <TypeChip type={item.type} />
                <time dateTime={pubDate.toISOString()} className="text-sm text-stone-500 dark:text-stone-400">
                    {formattedDate}
                </time>
            </div>

            <Title className="wr-display mt-3 text-3xl font-bold leading-tight tracking-tight text-stone-950 sm:text-4xl dark:text-stone-50">
                {item.title}
            </Title>

            <div className="mt-6">
                <SightingMarkdown markdown={item.body} trustedImages />
            </div>

            <div className="mt-8 flex items-center gap-3 border-t border-stone-900/10 pt-6 dark:border-white/10">
                <Image
                    src={item.authorAvatarUrl || "/brand/rat.svg"}
                    alt=""
                    width={40}
                    height={40}
                    className="h-10 w-10 shrink-0 rounded-full object-cover"
                />
                <div>
                    <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">{item.authorName}</p>
                    <p className="text-xs text-stone-500 dark:text-stone-400">WhereRat team</p>
                </div>
            </div>
        </article>
    );
}
