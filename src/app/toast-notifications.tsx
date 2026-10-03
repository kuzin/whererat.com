"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type ToastTone = "success" | "error" | "info";

const toastMessages: Record<string, { title: string; body: string; tone: ToastTone }> = {
  queued: {
    title: "Submission queued",
    body: "Thanks. The sighting is waiting for moderator review.",
    tone: "success",
  },
  approved: {
    title: "Submission approved",
    body: "The admin auto-approved this sighting and recorded the review.",
    tone: "success",
  },
  missing: {
    title: "Missing details",
    body: "Please fill in the required fields before submitting.",
    tone: "error",
  },
  "no-imdb": {
    title: "No IMDb match",
    body: "We couldn't find a matching movie. Try searching by title or IMDb ID.",
    tone: "error",
  },
  "profile-updated": {
    title: "Profile saved",
    body: "Your profile details were updated.",
    tone: "success",
  },
  "password-updated": {
    title: "Password updated",
    body: "Your password was changed successfully.",
    tone: "success",
  },
  "password-invalid": {
    title: "Password not changed",
    body: "Check your current password and confirmation.",
    tone: "error",
  },
  "logged-in": {
    title: "Logged in",
    body: "Welcome back to the rat control room.",
    tone: "success",
  },
  "logged-out": {
    title: "Logged out",
    body: "Your moderator session has ended.",
    tone: "info",
  },
  invalid: {
    title: "Login failed",
    body: "That username or password did not work.",
    tone: "error",
  },
  "too-many-attempts": {
    title: "Too many login attempts",
    body: "Please wait a few minutes before trying again.",
    tone: "error",
  },
  "moderation-saved": {
    title: "Edits saved",
    body: "The submission was updated and kept in the pending queue.",
    tone: "success",
  },
  "moderation-requeued": {
    title: "Returned to queue",
    body: "The submission has been moved back to the pending review queue.",
    tone: "info",
  },
  "invalid-movie": {
    title: "Title not saved",
    body: "Enter a movie or show title and a valid IMDb ID (tt1234567).",
    tone: "error",
  },
  "invalid-sighting": {
    title: "Not approved",
    body: "A sighting title, time in the film and description are required to approve.",
    tone: "error",
  },
  "movie-saved": {
    title: "Movie saved",
    body: "Movie info was updated successfully.",
    tone: "success",
  },
  "sighting-saved": {
    title: "Sighting saved",
    body: "The sighting has been updated.",
    tone: "success",
  },
  "sighting-images-saved": {
    title: "Images saved",
    body: "The sighting's images were updated.",
    tone: "success",
  },
  "sighting-images-missing": {
    title: "Sighting not found",
    body: "It may have been deleted or sent back to the queue. Nothing was saved.",
    tone: "error",
  },
  "resync-success": {
    title: "Resynced from IMDb",
    body: "Movie metadata was refreshed with the latest data from OMDb.",
    tone: "success",
  },
  "resync-complete": {
    title: "Sync complete",
    body: "Refreshed from IMDb.",   // overridden dynamically below
    tone: "success",
  },
  "resync-all-complete": {
    title: "Bulk sync complete",
    body: "Refreshed all movies from IMDb.", // overridden dynamically below
    tone: "success",
  },
  "resync-failed": {
    title: "Resync failed",
    body: "Could not reach OMDb. Check your API key or try again later.",
    tone: "error",
  },
  "resync-no-key": {
    title: "OMDb not configured",
    body: "Set OMDB_API_KEY to enable live metadata syncing.",
    tone: "info",
  },
  "moderation-approved": {
    title: "Sighting approved",
    body: "The submission has been approved and is now publicly visible.",
    tone: "success",
  },
  "moderation-rejected": {
    title: "Submission denied",
    body: "The submission has been rejected and moved to the history log.",
    tone: "info",
  },
  "user-created": {
    title: "User created",
    body: "The new account is ready. Share the credentials out-of-band.",
    tone: "success",
  },
  "user-updated": {
    title: "User updated",
    body: "Account details have been saved.",
    tone: "success",
  },
  "user-deleted": {
    title: "User deleted",
    body: "The account has been permanently removed.",
    tone: "info",
  },
  "news-created": {
    title: "Post created",
    body: "The news post has been saved.",
    tone: "success",
  },
  "news-updated": {
    title: "Post updated",
    body: "Changes to the news post were saved.",
    tone: "success",
  },
  "news-published": {
    title: "Post published",
    body: "The news post is now publicly visible.",
    tone: "success",
  },
  "news-unpublished": {
    title: "Post unpublished",
    body: "The news post has been moved back to draft.",
    tone: "info",
  },
  "news-deleted": {
    title: "Post deleted",
    body: "The news post has been permanently removed.",
    tone: "info",
  },
  "newsletter-sent": {
    title: "Newsletter sent",
    body: "Your digest is on its way to subscribers.",
    tone: "success",
  },
  "newsletter-empty": {
    title: "No posts selected",
    body: "Pick at least one published post before sending.",
    tone: "info",
  },
  "newsletter-no-subscribers": {
    title: "No subscribers yet",
    body: "Nobody has opted in to newsletters yet.",
    tone: "info",
  },
  "newsletter-test-sent": {
    title: "Test sent",
    body: "Check your inbox for the test newsletter.",
    tone: "success",
  },
  error: {
    title: "Something went wrong",
    body: "An unexpected error occurred. Please try again.",
    tone: "error",
  },
};

const toneBorder: Record<ToastTone, string> = {
  success: "border-green-700 dark:border-green-500",
  error: "border-red-700 dark:border-red-500",
  info: "border-amber-600 dark:border-amber-400",
};

const toneShadow: Record<ToastTone, string> = {
  success: "shadow-[0_8px_40px_rgb(0_0_0/0.3),4px_4px_0_0_rgb(21_128_61/0.7)] dark:shadow-[0_8px_40px_rgb(0_0_0/0.45),4px_4px_0_0_rgb(22_101_52/0.8)]",
  error: "shadow-[0_8px_40px_rgb(0_0_0/0.3),4px_4px_0_0_rgb(185_28_28/0.7)] dark:shadow-[0_8px_40px_rgb(0_0_0/0.45),4px_4px_0_0_rgb(153_27_27/0.8)]",
  info: "shadow-[0_8px_40px_rgb(0_0_0/0.3),4px_4px_0_0_rgb(180_83_9/0.7)] dark:shadow-[0_8px_40px_rgb(0_0_0/0.45),4px_4px_0_0_rgb(146_64_14/0.8)]",
};

export function ToastNotifications() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isVisible, setIsVisible] = useState(false);
  const toastKey = searchParams.get("toast") ?? searchParams.get("status") ?? searchParams.get("error");
  const toast = useMemo(() => {
    if (!toastKey) return undefined;
    const base = toastMessages[toastKey];
    if (!base) return undefined;

    if (toastKey === "resync-all-complete") {
      const synced = Number(searchParams.get("synced") ?? 0);
      const errors = Number(searchParams.get("errors") ?? 0);
      const lines: string[] = [];
      lines.push(`${synced} ${synced === 1 ? "movie" : "movies"} synced from IMDb`);
      if (errors > 0) {
        lines.push(`${errors} ${errors === 1 ? "movie" : "movies"} failed — check server logs`);
      }
      return { ...base, body: lines.join("\n") };
    }

    if (toastKey === "resync-complete") {
      const lines: string[] = [];

      // Metadata
      if (searchParams.get("meta") === "1") lines.push("Metadata updated from OMDb");

      // TMDB banner
      const tmdbBannerStatus = searchParams.get("tmdbbanner");
      let tmdbWarning = false;
      if (tmdbBannerStatus === "ok") {
        lines.push("Banner synced from TMDB");
      } else if (tmdbBannerStatus === "failed" || tmdbBannerStatus === "not-configured") {
        tmdbWarning = true;
        lines.push("No TMDB banner found — using poster");
      }

      return {
        ...base,
        tone: tmdbWarning ? "info" : base.tone,
        body: lines.join("\n"),
      };
    }

    return base;
  }, [toastKey, searchParams]);

  const dismiss = useCallback(() => {
    setIsVisible(false);
    const next = new URLSearchParams(searchParams.toString());
    next.delete("toast");
    next.delete("status");
    next.delete("error");
    next.delete("facts");
    next.delete("trivia");
    next.delete("meta");
    next.delete("reviews");
    next.delete("ratreviews");
    next.delete("related");
    next.delete("videos");
    next.delete("images");
    next.delete("synced");
    next.delete("errors");
    next.delete("tmdbbanner");
    next.delete("changed");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  useEffect(() => {
    if (!toast) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsVisible(false);
      return;
    }

    setIsVisible(true);

    const timeout = window.setTimeout(dismiss, 5500);

    return () => window.clearTimeout(timeout);
  }, [toast, dismiss]);

  if (!toast || !isVisible) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),5rem)] z-[9999] flex justify-end px-4 sm:px-6">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto w-full max-w-sm rounded-2xl border-2 bg-white p-5 dark:bg-stone-900/95 ${toneBorder[toast.tone]} ${toneShadow[toast.tone]}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="wr-display text-lg font-bold text-stone-900 dark:text-stone-50">{toast.title}</p>
            {toast.body.split("\n").filter(Boolean).map((line, i) => (
              <p key={i} className="mt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-300">{line}</p>
            ))}
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="mt-0.5 shrink-0 text-stone-400 transition-colors hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-200"
            aria-label="Dismiss notification"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="size-4">
              <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
