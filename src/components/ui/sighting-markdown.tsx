"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { sanitizePosterUrl } from "@/lib/submission-input";

const sightingMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h3 className="mt-5 mb-2 text-xl font-bold text-stone-950 first:mt-0 dark:text-stone-50">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-5 mb-2 text-lg font-bold text-stone-950 first:mt-0 dark:text-stone-50">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-2 border-b border-stone-200 pb-1 text-base font-bold text-stone-950 first:mt-0 dark:border-white/12 dark:text-stone-50">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-2 text-base font-bold text-stone-950 first:mt-0 dark:text-stone-50">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-4 mb-2 text-sm font-bold text-stone-950 first:mt-0 dark:text-stone-50">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-4 mb-2 text-sm font-bold text-stone-950 first:mt-0 dark:text-stone-50">
      {children}
    </h6>
  ),
  p: ({ children }) => (
    <p className="mb-3 text-base leading-relaxed text-stone-700 last:mb-0 dark:text-stone-300">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-bold text-stone-900 dark:text-stone-100">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-words font-semibold text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_88%,#000)] underline decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_55%,rgb(120_113_108/0.5))] underline-offset-2 hover:decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_90%,#000)] dark:text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_42%,rgb(245_240_232))] dark:decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_50%,rgb(245_240_232/0.45))] dark:hover:decoration-[color-mix(in_srgb,var(--movie-accent,#ea580c)_68%,rgb(245_240_232))]"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1 pl-6 text-stone-700 marker:text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_70%,rgb(120_113_108/0.6))] dark:text-stone-300 dark:marker:text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_55%,rgb(245_240_232/0.6))]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-6 text-stone-700 marker:font-semibold marker:text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_70%,rgb(120_113_108/0.6))] dark:text-stone-300 dark:marker:text-[color-mix(in_srgb,var(--movie-accent,#ea580c)_55%,rgb(245_240_232/0.6))]">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed [&>p]:my-0">{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-4 border-[color-mix(in_srgb,var(--movie-accent,#ea580c)_55%,rgb(120_113_108/0.55))] pl-4 text-stone-600 italic dark:border-[color-mix(in_srgb,var(--movie-accent,#ea580c)_48%,rgb(245_240_232/0.35))] dark:text-stone-400">
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr className="my-6 h-0 w-full border-0 border-t-2 border-stone-300 dark:border-white/30" />
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-xl border border-stone-200 bg-stone-100 p-4 text-sm dark:border-white/12 dark:bg-stone-950/60">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const isBlock =
      typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return (
        <code
          className={`block whitespace-pre font-mono text-[0.9rem] leading-relaxed text-stone-800 dark:text-stone-200 ${className ?? ""}`}
        >
          {children}
        </code>
      );
    }
    return (
      <code className="rounded-md bg-stone-200/90 px-1.5 py-0.5 font-mono text-[0.9em] text-stone-900 dark:bg-stone-800 dark:text-stone-100">
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="my-4 max-w-full overflow-x-auto rounded-lg border border-stone-200 dark:border-white/12">
      <table className="w-full min-w-[16rem] border-collapse text-left text-sm">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-stone-100 dark:bg-stone-900/80">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-t border-stone-200 odd:bg-white even:bg-stone-50/80 dark:border-white/10 dark:odd:bg-stone-950/30 dark:even:bg-stone-900/40">
      {children}
    </tr>
  ),
  th: ({ children }) => (
    <th className="border border-stone-200 px-3 py-2 font-bold text-stone-900 dark:border-white/12 dark:text-stone-100">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-stone-200 px-3 py-2 text-stone-700 dark:border-white/12 dark:text-stone-300">
      {children}
    </td>
  ),
};

/**
 * Sighting text is written by the public, so an image can only come from our own
 * site or an image host we already render. Anything else (a tracking pixel on an
 * arbitrary server, `javascript:`/`data:` URLs) falls back to its alt text.
 */
const sightingMarkdownComponentsRestrictedImages: Components = {
  ...sightingMarkdownComponents,
  img: ({ src, alt }) => {
    const safeSrc = typeof src === "string" ? sanitizePosterUrl(src) : undefined;
    if (!safeSrc) return <span>{alt ?? ""}</span>;
    return <img src={safeSrc} alt={alt ?? ""} loading="lazy" className="my-3 max-w-full rounded-lg" />;
  },
};

export function SightingMarkdown({
  markdown,
  className = "",
  trustedImages = false,
}: {
  markdown: string;
  className?: string;
  /** Owner-authored content (news) may embed images from any host. */
  trustedImages?: boolean;
}) {
  return (
    <div className={`sighting-markdown min-w-0 max-w-none ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={
          trustedImages ? sightingMarkdownComponents : sightingMarkdownComponentsRestrictedImages
        }
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
