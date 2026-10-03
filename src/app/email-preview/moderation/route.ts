/**
 * Owner-only preview of the "new sighting" email sent to moderators.
 * Renders fake data — no emails are sent from this route.
 */

import { renderBrandedEmail, type EmailContentBlock } from "@/lib/email-template";
import { formatApproximateRatLine } from "@/lib/whererat";
import { FAKE_SUBMISSION, requirePreviewOwner, wrapWithPreviewNav } from "../_fixtures";

export async function GET(request: Request) {
  const baseUrl = await requirePreviewOwner(request);
  const s = FAKE_SUBMISSION;
  const moderationUrl = `${baseUrl}/moderation`;

  const blocks: EmailContentBlock[] = [
    {
      kind: "paragraph",
      text: `A new sighting "${s.title}" is waiting for review.`,
    },
    {
      kind: "keyValue",
      rows: [
        { label: "Movie", value: `${s.movieTitle} (${s.movieYear})` },
        { label: "Point in film", value: s.timestamp },
        {
          label: "Count",
          value: `~${formatApproximateRatLine(s.approximateRatCount, s.rodentTypes)}`,
        },
        { label: "Submitted by", value: `${s.submittedBy} · ${s.submitterEmail}` },
        { label: "IMDb", value: s.imdbId! },
      ],
    },
    { kind: "quote", text: s.description },
    { kind: "gallery", images: s.images!.map((i) => ({ url: i.url, alt: i.alt })) },
    { kind: "button", button: { label: "Review in moderation queue", href: moderationUrl, fullWidth: true } },
  ];

  const { html } = renderBrandedEmail({
    preheader: `${s.movieTitle} (${s.movieYear}) — submitted by ${s.submittedBy}`,
    heading: s.title!,
    blocks,
    baseUrl: baseUrl,
  });

  return new Response(wrapWithPreviewNav(html, "moderation"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
