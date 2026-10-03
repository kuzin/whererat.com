/**
 * Transactional emails sent to the person who submitted a sighting:
 *   - "We got your sighting" — on submission
 *   - "Your sighting was approved" — after moderator approval
 *   - "Your sighting wasn't approved" — after moderator rejection
 *
 * All sends are best-effort and never throw — submission flows are never
 * blocked by an email failure.
 */

import { sendBrandedEmail } from "@/lib/email-send";
import { renderBrandedEmail, type EmailContentBlock } from "@/lib/email-template";
import { type Submission } from "@/lib/whererat";
import { optInConfirmUrl } from "@/lib/opt-in-token";
import { oneLine } from "@/lib/submission-input";
import { getSubscriber } from "@/lib/email-preferences-store";
import { getModeratorAccounts } from "@/lib/auth";

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://whererat.com";
}

function movieDisplay(submission: Submission): string {
  const base = submission.movieYear
    ? `${submission.movieTitle} (${submission.movieYear})`
    : submission.movieTitle;
  if (
    submission.imdbKind === "series" &&
    submission.seasonNumber &&
    submission.episodeNumber
  ) {
    const ep = `S${submission.seasonNumber}E${submission.episodeNumber}${submission.episodeTitle ? `: ${submission.episodeTitle}` : ""
      }`;
    return `${base} — ${ep}`;
  }
  return base;
}

const SUBMITTER_FOOTER = "You're receiving this because you submitted a sighting to WhereRat.";

async function getFooter(
  email?: string,
): Promise<{ footerNote: string; footerUnsubscribeUrl?: string }> {
  if (!email) return { footerNote: SUBMITTER_FOOTER };
  const subscriber = await getSubscriber(email);
  if (!subscriber) return { footerNote: SUBMITTER_FOOTER };
  return {
    footerNote: SUBMITTER_FOOTER,
    footerUnsubscribeUrl: `${siteUrl()}/unsubscribed?token=${encodeURIComponent(subscriber.unsubscribeToken)}`,
  };
}

async function buildReceiptEmail(submission: Submission, offerNewsOptIn: boolean) {
  const headline = oneLine(submission.title?.trim() || movieDisplay(submission));
  const subject = `We got your sighting: ${headline}`;

  const firstName = submission.submittedBy?.trim().split(/\s+/)[0];
  const greeting = firstName
    ? `We got it, ${firstName}! We’ll email you when it’s reviewed — usually within a few days.`
    : `We got it! We’ll email you when it’s reviewed — usually within a few days.`;

  const blocks: EmailContentBlock[] = [
    {
      kind: "paragraph",
      text: greeting,
    },
    {
      kind: "button",
      button: { label: "Browse the catalog", href: `${siteUrl()}/catalog` },
    },
  ];

  // They ticked "send me updates" on the form. An address typed into a public form
  // proves nothing, so subscribing needs a click from the mailbox owner. Skipped
  // if they're already subscribed (the footer then shows the unsubscribe link).
  const footer = await getFooter(submission.submitterEmail);
  if (offerNewsOptIn && submission.submitterEmail && !footer.footerUnsubscribeUrl) {
    blocks.push(
      { kind: "divider" },
      {
        kind: "paragraph",
        text: "You asked to hear about new WhereRat updates. Confirm below and we'll add this address. If it wasn't you, just ignore this.",
        muted: true,
      },
      {
        kind: "button",
        button: {
          label: "Yes, send me updates",
          href: optInConfirmUrl(siteUrl(), submission.submitterEmail),
        },
      },
    );
  }

  const { html, text } = renderBrandedEmail({
    preheader: `Your sighting “${headline}” is in the moderation queue.`,
    heading: "Thanks for the sighting!",
    emoji: "🐀",
    centered: true,
    ...footer,
    blocks,
  });

  return { subject, html, text };
}

export async function notifySubmitterOfReceipt(
  submission: Submission,
  options?: { offerNewsOptIn?: boolean },
): Promise<void> {
  try {
    await sendReceipt(submission, options?.offerNewsOptIn === true);
  } catch (error) {
    // Best-effort: a failed e-mail must never fail (or crash after) the submission.
    console.error("[submitter-notify] receipt failed:", error);
  }
}

async function sendReceipt(submission: Submission, offerNewsOptIn: boolean): Promise<void> {
  const to = submission.submitterEmail?.trim();
  if (!to) return;

  // Prevent sending to moderators (by email match)
  const moderatorEmails = getModeratorAccounts().map((m) => m.email.toLowerCase());
  if (moderatorEmails.includes(to.toLowerCase())) return;

  const { subject, html, text } = await buildReceiptEmail(submission, offerNewsOptIn);
  await sendBrandedEmail({ to, subject, html, text, logTag: "submitter-notify" });
}

async function buildApprovedEmail(submission: Submission) {
  const headline = oneLine(submission.title?.trim() || movieDisplay(submission));
  const subject = `Your sighting was approved: ${headline}`;
  const firstName = submission.submittedBy?.trim().split(/\s+/)[0];
  const body = firstName
    ? `Great eye, ${firstName}! Your sighting is now live on WhereRat.`
    : "Your sighting is now live on WhereRat.";

  const blocks: EmailContentBlock[] = [
    { kind: "paragraph", text: body },
    {
      kind: "button",
      button: { label: "Browse the catalog", href: `${siteUrl()}/catalog` },
    },
  ];

  const { html, text } = renderBrandedEmail({
    preheader: `Your sighting "${headline}" is now live on WhereRat.`,
    heading: "Your sighting was approved!",
    emoji: "🎉",
    centered: true,
    ...(await getFooter(submission.submitterEmail)),
    blocks,
  });

  return { subject, html, text };
}

async function buildRejectedEmail(submission: Submission) {
  const headline = oneLine(submission.title?.trim() || movieDisplay(submission));
  const subject = `Update on your WhereRat sighting: ${headline}`;
  const firstName = submission.submittedBy?.trim().split(/\s+/)[0];
  const body = firstName
    ? `Thanks for the submission, ${firstName}. After review, this one wasn't a fit for the catalog.`
    : "Thanks for the submission. After review, this one wasn't a fit for the catalog.";

  const blocks: EmailContentBlock[] = [
    { kind: "paragraph", text: body },
    {
      kind: "button",
      button: { label: "Browse the catalog", href: `${siteUrl()}/catalog` },
    },
  ];

  const { html, text } = renderBrandedEmail({
    preheader: `An update on your sighting "${headline}".`,
    heading: "Not quite this time.",
    emoji: "🐭",
    centered: true,
    ...(await getFooter(submission.submitterEmail)),
    blocks,
  });

  return { subject, html, text };
}

export async function notifySubmitterOfDecision(
  submission: Submission,
  decision: "approved" | "rejected",
): Promise<void> {
  try {
    await sendDecision(submission, decision);
  } catch (error) {
    console.error("[submitter-notify] decision e-mail failed:", error);
  }
}

async function sendDecision(
  submission: Submission,
  decision: "approved" | "rejected",
): Promise<void> {
  const to = submission.submitterEmail?.trim();
  if (!to) return;

  // Prevent sending to moderators (by email match)
  const moderatorEmails = getModeratorAccounts().map((m) => m.email.toLowerCase());
  if (moderatorEmails.includes(to.toLowerCase())) return;

  const { subject, html, text } =
    decision === "approved"
      ? await buildApprovedEmail(submission)
      : await buildRejectedEmail(submission);

  await sendBrandedEmail({ to, subject, html, text, logTag: "submitter-notify" });
}
