import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ExternalLinkIcon } from "@/components/ui/external-link-icon";
import {
  formatSubmissionEpisodeContext,
  formatApproximateRatLine,
  formatContentWarningLabel,
  formatSightingMomentDisplay,
  formatRuntimeMinutes,
  formatPercentAsTimestamp,
  getImdbTitleUrl,
  getMoviePath,
  getSubmissionImageRefs,
  getSubmissionSightingTitle,
  CONTENT_WARNING_OPTIONS,
  RODENT_TYPE_OPTIONS,
} from "@/lib/whererat";
import { ModerationEditModal } from "./moderation-edit-modal";
import { InlineApproveForm } from "@/components/moderation/inline-approve-form";
import { HistoryList } from "@/components/moderation/history-list";
import { SightingsTabs } from "@/components/moderation/sightings-tabs";
import { SubmissionImageThumbs } from "@/components/moderation/submission-image-thumbs";
import { SightingMarkdown } from "@/components/ui/sighting-markdown";
import {
  MODERATOR_SESSION_COOKIE,
  parseModeratorSession,
} from "@/lib/auth";
import { moderateSubmission, removeSubmission, rereviewSubmission, resyncAllMovies } from "./actions";
import { readModerationStore } from "@/lib/moderation-store";
import {
  getCatalogMovieByImdbId,
  getCatalogMovieByExactTitle,
  getCatalogStatsWithCommunity,
} from "@/lib/movie-catalog";
import { ResyncAllButton } from "@/components/moderation/resync-all-button";
import { readUserStore } from "@/lib/user-store";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: "Moderation Queue",
  description:
    "Review pending submissions, approve or reject sightings, and manage catalog moderation activity.",
  robots: {
    index: false,
    follow: false,
  },
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const HISTORY_PAGE_SIZE = 20;

function fallbackAvatarUrl(_name: string) {
  return "/brand/rat.svg";
}

export default async function ModerationPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const cookieStore = await cookies();
  const session = parseModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );

  if (!session) {
    redirect("/login?next=/moderation");
  }

  const store = await readModerationStore();
  const pendingSubmissions = store.submissions.filter(
    (submission) => submission.status === "pending",
  );
  const approvedSubmissions = store.submissions.filter(
    (submission) => submission.status === "approved",
  );
  const deniedSubmissions = store.submissions.filter(
    (submission) => submission.status === "rejected",
  );
  const params = searchParams ? await searchParams : {};
  const editingSubmissionId = single(params.edit);
  const pendingPageRaw = Number.parseInt(String(single(params.page) ?? "1"), 10);
  const requestedPendingPage =
    Number.isFinite(pendingPageRaw) && pendingPageRaw > 0 ? Math.floor(pendingPageRaw) : 1;
  const pendingPageCount = Math.max(1, Math.ceil(pendingSubmissions.length / HISTORY_PAGE_SIZE));
  const safePendingPage = Math.min(requestedPendingPage, pendingPageCount);
  const pendingStart = (safePendingPage - 1) * HISTORY_PAGE_SIZE;
  const pendingSlice = pendingSubmissions.slice(pendingStart, pendingStart + HISTORY_PAGE_SIZE);
  const pendingPath = (page: number) =>
    page <= 1 ? "/moderation" : `/moderation?page=${page}`;

  // Build reviewer lookup for all history items (both tabs)
  const allHistorySubmissions = [...approvedSubmissions, ...deniedSubmissions];
  const historyReviewerBySubmissionId = new Map<string, string>();
  for (const submission of allHistorySubmissions) {
    const isApproved = submission.status === "approved";
    const relevantActions = new Set(
      isApproved ? ["approved", "edited and approved"] : ["rejected"],
    );
    const latestAction = store.reviewActions
      .filter(
        (action) =>
          action.submissionId === submission.id && relevantActions.has(action.action),
      )
      .sort(
        (a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime(),
      )[0];
    if (latestAction?.moderatorName) {
      historyReviewerBySubmissionId.set(submission.id, latestAction.moderatorName);
    }
  }

  // Build view hrefs for all approved submissions
  const approvedViewEntries = await Promise.all(
    approvedSubmissions.map(async (submission) => {
      const movie =
        (submission.imdbId
          ? await getCatalogMovieByImdbId(submission.imdbId)
          : undefined) ?? (await getCatalogMovieByExactTitle(submission.movieTitle));
      return movie ? ([submission.id, getMoviePath(movie)] as const) : undefined;
    }),
  );
  const approvedViewHrefBySubmissionId = new Map<string, string>(
    approvedViewEntries.filter((e) => e !== undefined) as Array<readonly [string, string]>,
  );

  const approvedItems = approvedSubmissions.map((submission) => ({
    submission,
    reviewerName: historyReviewerBySubmissionId.get(submission.id),
    viewHref: approvedViewHrefBySubmissionId.get(submission.id),
  }));
  const deniedItems = deniedSubmissions.map((submission) => ({
    submission,
    reviewerName: historyReviewerBySubmissionId.get(submission.id),
  }));

  const editingSubmission =
    editingSubmissionId
      ? store.submissions.find((submission) => submission.id === editingSubmissionId)
      : undefined;
  const editingMovieRuntimeMinutes = editingSubmission?.imdbId
    ? (await getCatalogMovieByImdbId(editingSubmission.imdbId))?.runtimeMinutes
    : undefined;
  const pendingMovieEntries = await Promise.all(
    pendingSlice.map(async (submission) => {
      const movie =
        (submission.imdbId
          ? await getCatalogMovieByImdbId(submission.imdbId)
          : undefined) ?? (await getCatalogMovieByExactTitle(submission.movieTitle));
      return [submission.id, movie] as const;
    }),
  );
  const catalogMovieBySubmissionId = new Map(
    pendingMovieEntries.filter(([, movie]) => movie !== undefined),
  );

  const stats = await getCatalogStatsWithCommunity();
  const userStore = await readUserStore();
  const trustSignalAccounts = [...userStore.accounts]
    .map((account) => ({
      id: account.id,
      displayName: account.name,
      roleLabel: account.role === "owner" ? "Owner" : "Moderator",
      avatarUrl: account.avatarUrl || fallbackAvatarUrl(account.name),
      reviewCount: store.reviewActions.filter((action) => action.moderatorId === account.id).length,
    }))
    .sort((a, b) => b.reviewCount - a.reviewCount || a.displayName.localeCompare(b.displayName));
  return (
    <main className="wr-page-shell py-10">
      {session.role === "owner" ? (
        <div className="mb-8 rounded-2xl border border-amber-600/40 bg-amber-50/80 px-5 py-4 dark:border-amber-500/20 dark:bg-amber-950/15">
          <div className="mb-3 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 dark:text-amber-400" aria-hidden>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-sm font-bold text-amber-800 dark:text-amber-300">Owner controls</span>
          </div>
          <div className="flex items-center gap-1">
            <form action={resyncAllMovies}>
              <ResyncAllButton />
            </form>
            <Link
              href="/moderation/users"
              title="Manage Users"
              aria-label="Manage Users"
              className="wr-btn-ghost inline-flex h-11 w-11 items-center justify-center px-0 py-0"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </Link>
            <Link
              href="/moderation/news"
              title="Manage News"
              aria-label="Manage News"
              className="wr-btn-ghost inline-flex h-11 w-11 items-center justify-center px-0 py-0"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
                <path d="M18 14h-8" />
                <path d="M15 18h-5" />
                <path d="M10 6h8v4h-8V6Z" />
              </svg>
            </Link>
            <Link
              href="/email-preview/newsletter"
              title="Email previews"
              aria-label="Email previews"
              className="wr-btn-ghost inline-flex h-11 w-11 items-center justify-center px-0 py-0"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect width="20" height="16" x="2" y="4" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </Link>
          </div>
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-6">
        <aside className="contents">
          <div className="order-3 wr-card-soft space-y-3 p-5 sm:p-7">
            <h2 className="text-xl font-black text-stone-950 dark:text-stone-100">Queue health</h2>
            <dl className="mt-3 divide-y divide-stone-900/12 dark:divide-white/12">
              <div className="flex items-center justify-between py-3">
                <dt className="flex items-center gap-2 font-bold text-stone-600 dark:text-stone-300">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full bg-yellow-500 dark:bg-yellow-400"
                  />
                  Pending
                </dt>
                <dd className="text-2xl font-black text-stone-950 dark:text-yellow-100">{pendingSubmissions.length}</dd>
              </div>
              <div className="flex items-center justify-between py-3">
                <dt className="flex items-center gap-2 font-bold text-stone-600 dark:text-stone-300">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
                  />
                  Verified public
                </dt>
                <dd className="text-2xl font-black text-stone-950 dark:text-emerald-100">{stats.sightings}</dd>
              </div>
              <div className="flex items-center justify-between py-3">
                <dt className="flex items-center gap-2 font-bold text-stone-600 dark:text-stone-300">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500 dark:bg-rose-400"
                  />
                  Spoiler flags
                </dt>
                <dd className="text-2xl font-black text-stone-950 dark:text-rose-100">{stats.spoilerSightings}</dd>
              </div>
            </dl>
          </div>

          <div className="order-4 wr-card-soft space-y-3 p-5 sm:p-7">
            <h2 className="text-xl font-black text-stone-950 dark:text-stone-100">User trust signals</h2>
            <div className="mt-2 divide-y divide-stone-900/12 dark:divide-white/12">
              {trustSignalAccounts.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="flex items-center gap-3">
                    <Image
                      src={user.avatarUrl}
                      alt={`${user.displayName} avatar`}
                      width={40}
                      height={40}
                      className="h-10 w-10 rounded-xl border border-stone-900/12 object-cover dark:border-white/16"
                    />
                    <div>
                      <p className="font-black text-stone-950 dark:text-stone-100">{user.displayName}</p>
                      <p className="text-sm text-stone-500 dark:text-stone-400">{user.roleLabel}</p>
                    </div>
                  </div>
                  <p className="flex items-baseline gap-1.5 text-right">
                    <span className="font-black text-stone-950 dark:text-stone-100">
                      {user.reviewCount}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 dark:text-stone-400">
                      Reviews
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </div>

        </aside>

        <section
          className="order-2 wr-card-soft p-6 sm:p-7"
          aria-label="Sightings"
        >
          <SightingsTabs
            pendingCount={pendingSubmissions.length}
            approvedCount={approvedSubmissions.length}
            deniedCount={deniedSubmissions.length}
            pendingContent={
              <>
                <div className="space-y-5">
                  {pendingSubmissions.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-stone-500/75 bg-stone-100/90 p-10 text-center dark:border-white/20 dark:bg-stone-900/40">
                      <img src="/openmoji/color/svg/1F573.svg" alt="" width={40} height={40} className="mx-auto" aria-hidden />
                      <h3 className="wr-display mt-3 text-2xl font-bold">
                        Quiet burrow. No crumbs.
                      </h3>
                      <p className="mt-2 text-stone-700 dark:text-stone-300">
                        New public submissions will appear here as pending reviews.
                      </p>
                    </div>
                  ) : null}

                  {pendingSlice.map((submission) => {
              const attachmentSlides = getSubmissionImageRefs(submission);
              const sightingTitle = getSubmissionSightingTitle(submission);
              const startingPretty = formatSightingMomentDisplay(submission.timestamp);
              const episodeContext = formatSubmissionEpisodeContext(submission);
              const isSeriesSubmission = submission.imdbKind === "series";
              const catalogMovie = catalogMovieBySubmissionId.get(submission.id);
              const posterUrl = catalogMovie?.posterUrl ?? submission.moviePosterUrl;
              return (
                <article
                  key={submission.id}
                  className="wr-card overflow-hidden rounded-2xl"
                >
                  <div className="p-4 sm:p-5">
                    <div>

                      {/* ── Movie block ── */}
                      <div className="flex gap-4">
                        {posterUrl ? (
                          <div className="w-14 sm:w-20 shrink-0 self-stretch">
                            <Image
                              src={posterUrl}
                              alt={`${submission.movieTitle} poster`}
                              width={80}
                              height={120}
                              className="h-full w-full rounded-lg object-cover"
                            />
                          </div>
                        ) : null}
                        <div className="min-w-0 self-start">
                          <h3 className="text-xl font-black text-stone-950 dark:text-stone-100">
                            {submission.movieTitle}
                            {submission.movieYear ? (
                              <span className="ml-1.5 text-base font-semibold text-stone-500 dark:text-stone-400">
                                ({submission.movieYear})
                              </span>
                            ) : null}
                          </h3>
                          {episodeContext ? (
                            <p className="mt-0.5 truncate text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 dark:text-stone-400">
                              {episodeContext}
                            </p>
                          ) : null}
                          {catalogMovie ? (
                            <div className="mt-1 space-y-0.5 text-sm text-stone-600 dark:text-stone-400">
                              {catalogMovie.metadata.director ? (
                                <p>Dir. <span className="font-medium text-stone-800 dark:text-stone-200">{catalogMovie.metadata.director}</span></p>
                              ) : null}
                              {catalogMovie.genres.length > 0 ? (
                                <p>{catalogMovie.genres.join(" · ")}</p>
                              ) : null}
                              <p className="flex flex-wrap gap-x-3">
                                {catalogMovie.runtimeMinutes ? <span>{catalogMovie.runtimeMinutes} min</span> : null}
                                {catalogMovie.metadata.rating ? <span>{catalogMovie.metadata.rating}</span> : null}
                                {catalogMovie.metadata.imdbRating ? <span>★ {catalogMovie.metadata.imdbRating}</span> : null}
                              </p>
                            </div>
                          ) : null}
                          {!catalogMovie ? (
                            <div className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                              {submission.imdbId ? (
                                <a href={getImdbTitleUrl(submission.imdbId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-orange-950 underline decoration-orange-900/35 underline-offset-2 hover:decoration-orange-950 dark:text-amber-200 dark:decoration-amber-200/35 dark:hover:decoration-amber-200">
                                  IMDb {submission.imdbId}
                                  <ExternalLinkIcon className="size-3 opacity-60" />
                                </a>
                              ) : (
                                <span className="opacity-50">No IMDb match</span>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {/* ── Duplicate warning ── */}
                      {catalogMovie ? (
                        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-600/60 bg-amber-100 px-3 py-2.5 text-xs font-semibold text-amber-950 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-200">
                          <img src="/openmoji/color/svg/26A0.svg" alt="" width={16} height={16} className="mt-px shrink-0" aria-hidden />
                          <span>Already in catalog — verify this isn&apos;t a duplicate sighting before approving.</span>
                        </div>
                      ) : null}

                      <div className="mt-4 border-t border-stone-950/8 dark:border-white/8" />

                      {/* ── Sighting block ── */}
                      <dl className="mt-3 grid grid-cols-1 gap-y-0.5 text-sm sm:grid-cols-[10rem_1fr] sm:gap-x-3 sm:gap-y-2 [&_dt]:mt-4 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:uppercase [&_dt]:tracking-wide [&_dt]:opacity-60 sm:[&_dt]:mt-0 sm:[&_dt]:text-sm sm:[&_dt]:font-bold sm:[&_dt]:normal-case sm:[&_dt]:tracking-normal sm:[&_dt]:opacity-100">
                        {episodeContext ? (
                          <>
                            <dt className="font-bold text-stone-600 dark:text-stone-400">Episode</dt>
                            <dd className="text-stone-700 dark:text-stone-200">{episodeContext}</dd>
                          </>
                        ) : null}
                        <dt className="font-bold text-stone-600 dark:text-stone-400">
                          Point in {isSeriesSubmission ? "episode" : "film"}
                        </dt>
                        <dd className="text-stone-700 dark:text-stone-200">
                          {startingPretty.replace(" into movie", "")}
                          {catalogMovie?.runtimeMinutes && (
                            <>
                              {" · "}
                              <span className="text-stone-500 dark:text-stone-400">
                                {formatPercentAsTimestamp(submission.timestamp, catalogMovie.runtimeMinutes) ?? "—"}
                              </span>
                            </>
                          )}
                        </dd>
                        <dt className="font-bold text-stone-600 dark:text-stone-400">Count</dt>
                        <dd className="text-stone-700 dark:text-stone-200">
                          ~{formatApproximateRatLine(submission.approximateRatCount, submission.rodentTypes)}
                        </dd>
                        {catalogMovie?.runtimeMinutes ? (
                          <>
                            <dt className="font-bold text-stone-600 dark:text-stone-400">Duration</dt>
                            <dd className="text-stone-700 dark:text-stone-200">{formatRuntimeMinutes(catalogMovie.runtimeMinutes)}</dd>
                          </>
                        ) : null}
                        {submission.imdbId ? (
                          <>
                            <dt className="font-bold text-stone-600 dark:text-stone-400">IMDb</dt>
                            <dd>
                              <a href={getImdbTitleUrl(submission.imdbId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-orange-950 underline decoration-orange-900/35 underline-offset-2 hover:decoration-orange-950 dark:text-amber-200 dark:decoration-amber-200/35 dark:hover:decoration-amber-200">
                                {submission.imdbId}
                                <ExternalLinkIcon className="size-3 opacity-60" />
                              </a>
                            </dd>
                          </>
                        ) : null}
                        <dt className="font-bold text-stone-600 dark:text-stone-400">Submitted by</dt>
                        <dd className="text-stone-700 dark:text-stone-200">
                          {submission.submittedBy.trim()}
                          {submission.submitterEmail ? (
                            <>
                              {" · "}
                              <a
                                href={`mailto:${submission.submitterEmail}`}
                                className="font-semibold text-orange-950 underline decoration-orange-900/35 underline-offset-2 hover:decoration-orange-950 dark:text-amber-200 dark:decoration-amber-200/35 dark:hover:decoration-amber-200"
                              >
                                {submission.submitterEmail}
                              </a>
                            </>
                          ) : null}
                        </dd>
                        <dt className="font-bold text-stone-600 dark:text-stone-400">Submitted</dt>
                        <dd className="text-stone-700 dark:text-stone-200">
                          <time dateTime={submission.submittedAt.toISOString()}>
                            {submission.submittedAt.toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZoneName: "short",
                            })}
                          </time>
                        </dd>
                        {(() => {
                          const rodentTypes = submission.rodentTypes ?? [];
                          const warnings = submission.contentWarnings ?? [];
                          if (!submission.spoiler && rodentTypes.length === 0 && warnings.length === 0) return null;
                          return (
                            <>
                              <dt className="font-bold text-stone-600 dark:text-stone-400">Tags</dt>
                              <dd className="col-span-1">
                                <div className="flex flex-wrap gap-1.5">
                                  {rodentTypes.map((id) => {
                                    const opt = RODENT_TYPE_OPTIONS.find((o) => o.id === id);
                                    const isOther = id === "other";
                                    const otherLabel = submission.otherRodentLabel?.trim();
                                    const display = isOther
                                      ? otherLabel
                                        ? `Other: ${otherLabel}`
                                        : "Other"
                                      : (opt?.label ?? id);
                                    const code = isOther ? "270F" : (opt?.openmojiCode ?? "26A0");
                                    return (
                                      <span key={id} className="inline-flex items-center gap-1 rounded-md border border-amber-700/35 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950 dark:border-amber-400/25 dark:bg-amber-950/35 dark:text-amber-200">
                                        <img src={`/openmoji/color/svg/${code}.svg`} alt="" width={18} height={18} aria-hidden />
                                        {display}
                                      </span>
                                    );
                                  })}
                                  {submission.spoiler ? (
                                    <span className="inline-flex items-center rounded-md border border-red-700/35 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-950 dark:border-red-400/30 dark:bg-red-950/35 dark:text-red-200">
                                      Spoiler
                                    </span>
                                  ) : null}
                                  {warnings.map((id) => {
                                    const opt = CONTENT_WARNING_OPTIONS.find((o) => o.id === id);
                                    return (
                                      <span key={id} className="inline-flex items-center gap-1 rounded-md border border-yellow-700/35 bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-950 dark:border-yellow-400/25 dark:bg-yellow-950/35 dark:text-yellow-200">
                                        <img src={`/openmoji/color/svg/${opt?.openmojiCode ?? "26A0"}.svg`} alt="" width={18} height={18} aria-hidden />
                                        {formatContentWarningLabel(id, submission.rodentTypes)}
                                      </span>
                                    );
                                  })}
                                </div>
                              </dd>
                            </>
                          );
                        })()}
                      </dl>
                      {!catalogMovie && submission.imdbId ? (
                        <div className="mt-3 rounded-lg border border-stone-900/15 bg-stone-50 p-2.5 text-xs text-stone-700 dark:border-white/12 dark:bg-stone-900/30 dark:text-stone-300">
                          <p className="leading-relaxed">
                            <strong><img src="/openmoji/color/svg/1F4CC.svg" alt="" width={14} height={14} style={{ display: "inline", verticalAlign: "middle" }} aria-hidden /> Note:</strong> This film is not yet in the catalog. Runtime data will be available once synced with IMDb (timestamp conversion requires duration). Approve to add it to the catalog.
                          </p>
                        </div>
                      ) : null}
                      <div className="mt-3 border-t border-stone-950/8 pt-3 dark:border-white/8">
                        <p className="mb-1.5 text-sm font-bold text-stone-600 dark:text-stone-400">Title</p>
                        <p className="mb-3 text-sm text-stone-700 dark:text-stone-200">{sightingTitle}</p>
                        <p className="mb-1.5 text-sm font-bold text-stone-600 dark:text-stone-400">Description</p>
                        <SightingMarkdown markdown={submission.description} />
                      </div>
                    </div>

                    {attachmentSlides.length > 0 ? (
                      <div className="mt-4 overflow-hidden rounded-xl border border-stone-900/15 bg-stone-50 dark:border-white/12 dark:bg-stone-900/50">
                        <SubmissionImageThumbs slides={attachmentSlides} />
                      </div>
                    ) : null}

                    <div className="mt-5">
                      <InlineApproveForm
                        submissionId={submission.id}
                        editHref={`/moderation?edit=${submission.id}`}
                        moderateAction={moderateSubmission}
                      />
                    </div>
                  </div>
                  </article>
                );
              })}
                </div>

                {pendingPageCount > 1 ? (
                  <div className="mt-8 flex items-center justify-between gap-3">
                    <Link
                      href={pendingPath(safePendingPage - 1)}
                      className={`wr-btn-ghost ${safePendingPage === 1 ? "pointer-events-none cursor-not-allowed opacity-40" : ""}`}
                      aria-disabled={safePendingPage === 1}
                    >
                      ← Previous
                    </Link>
                    <p className="text-sm font-semibold text-stone-600 dark:text-stone-300">
                      Showing {pendingStart + 1}–{pendingStart + pendingSlice.length} of {pendingSubmissions.length}
                    </p>
                    <Link
                      href={pendingPath(safePendingPage + 1)}
                      className={`wr-btn-ghost ${safePendingPage === pendingPageCount ? "pointer-events-none cursor-not-allowed opacity-40" : ""}`}
                      aria-disabled={safePendingPage === pendingPageCount}
                    >
                      Next →
                    </Link>
                  </div>
                ) : null}
              </>
            }
            approvedContent={
              <HistoryList
                items={approvedItems}
                mode="approved"
                rereviewAction={rereviewSubmission}
                removeAction={removeSubmission}
              />
            }
            deniedContent={
              <HistoryList
                items={deniedItems}
                mode="denied"
                rereviewAction={rereviewSubmission}
                removeAction={removeSubmission}
              />
            }
          />
        </section>
      </section>

      {editingSubmission ? (
        <ModerationEditModal
          submission={editingSubmission}
          moderateAction={moderateSubmission}
          runtimeMinutes={editingMovieRuntimeMinutes}
        />
      ) : null}
    </main>
  );
}
