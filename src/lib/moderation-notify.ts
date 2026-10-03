/**
 * Email notification to the site owner when a new sighting submission lands
 * in the moderation queue. Best-effort: failures are logged but never thrown,
 * so a misconfigured/missing RESEND_API_KEY can't break public submissions.
 */

import { oneLine } from "@/lib/submission-input";
import { getDbPool } from "@/lib/db";
import { sendBrandedEmail } from "@/lib/email-send";
import { renderBrandedEmail, type EmailContentBlock } from "@/lib/email-template";
import { formatApproximateRatLine, type Submission } from "@/lib/whererat";

async function getModeratorEmails(): Promise<string[]> {
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{ email: string }>(
      `select email from accounts where role in ('owner', 'moderator') order by created_at asc`,
    );
    return rows.map((r) => r.email).filter((e): e is string => Boolean(e && e.trim()));
  } catch (e) {
    console.warn("[moderation-notify] moderator lookup failed:", e);
    return [];
  }
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://whererat.com";
}

function buildSubmissionEmail(submission: Submission) {
  const movieLine = submission.movieYear
    ? `${submission.movieTitle} (${submission.movieYear})`
    : submission.movieTitle;
  const episodePart =
    submission.imdbKind === "series" && submission.seasonNumber && submission.episodeNumber
      ? ` — S${submission.seasonNumber}E${submission.episodeNumber}${
          submission.episodeTitle ? `: ${submission.episodeTitle}` : ""
        }`
      : "";

  const moderationUrl = `${siteUrl()}/moderation`;
  const headline = oneLine(submission.title?.trim() || `${movieLine}${episodePart}`);
  const subject = `New sighting: ${headline}`;

  const isSeries = submission.imdbKind === "series";
  const rows: Array<{ label: string; value: string }> = [
    { label: "Movie", value: `${movieLine}${episodePart}` },
    { label: `Point in ${isSeries ? "episode" : "film"}`, value: submission.timestamp },
    {
      label: "Count",
      value: `~${formatApproximateRatLine(submission.approximateRatCount, submission.rodentTypes)}`,
    },
    {
      label: "Submitted by",
      value: submission.submitterEmail
        ? `${submission.submittedBy} · ${submission.submitterEmail}`
        : submission.submittedBy,
    },
  ];
  if (submission.imdbId) {
    rows.push({ label: "IMDb", value: submission.imdbId });
  }
  if (submission.spoiler) {
    rows.push({ label: "Spoiler", value: "Yes" });
  }

  const blocks: EmailContentBlock[] = [
    {
      kind: "paragraph",
      text: `A new sighting "${submission.title ?? "(untitled)"}" is waiting for review.`,
    },
    { kind: "keyValue", rows },
    { kind: "quote", text: submission.description },
  ];

  if (submission.images?.length) {
    blocks.push({
      kind: "gallery",
      images: submission.images.map((img) => ({ url: img.url, alt: img.alt })),
    });
  }

  blocks.push({
    kind: "button",
    button: { label: "Review in moderation queue", href: moderationUrl, fullWidth: true },
  });

  const { html, text } = renderBrandedEmail({
    preheader: `${movieLine}${episodePart} — submitted by ${submission.submittedBy}`,
    heading: headline,
    blocks,
  });

  return { subject, html, text };
}

export async function notifyOwnerOfNewSubmission(
  submission: Submission,
  _catalogMatchSlug?: string,
): Promise<void> {
  const recipients = await getModeratorEmails();
  if (!recipients.length) {
    console.warn("[moderation-notify] no moderator emails; skipping notification.");
    return;
  }

  const { subject, text, html } = buildSubmissionEmail(submission);

  // Send one email per moderator so addresses aren't exposed across the team.
  await Promise.all(
    recipients.map((to) =>
      sendBrandedEmail({ to, subject, html, text, logTag: "moderation-notify" }),
    ),
  );
}
