/**
 * Owner-only preview of the "we got your sighting" email sent to submitters.
 * Renders fake data — no emails are sent from this route.
 */

import { renderBrandedEmail, type EmailContentBlock } from "@/lib/email-template";
import { FAKE_SUBMISSION, requirePreviewOwner, wrapWithPreviewNav } from "../_fixtures";

const SUBMITTER_FOOTER = "You're receiving this because you submitted a sighting to WhereRat.";

export async function GET(request: Request) {
  const baseUrl = await requirePreviewOwner(request);
  const s = FAKE_SUBMISSION;
  const firstName = s.submittedBy.trim().split(/\s+/)[0];

  const blocks: EmailContentBlock[] = [
    {
      kind: "paragraph",
      text: `We got it, ${firstName}! We'll email you when it's reviewed — usually within a few days.`,
    },
    {
      kind: "button",
      button: { label: "Browse the catalog", href: `${baseUrl}/catalog` },
    },
  ];

  const { html } = renderBrandedEmail({
    preheader: `Your sighting "${s.title}" is in the moderation queue.`,
    heading: "Thanks for the sighting!",
    emoji: "🐀",
    centered: true,
    footerNote: SUBMITTER_FOOTER,
    blocks,
    baseUrl: baseUrl,
  });

  return new Response(wrapWithPreviewNav(html, "submitter-receipt"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
