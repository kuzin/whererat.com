import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MODERATOR_SESSION_COOKIE } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import type { Submission } from "@/lib/whererat";

/**
 * Call at the top of every email-preview route. Owner only, like the other owner
 * controls (these used to 404 in production, which also blanked the live preview in the
 * newsletter composer). Returns the origin the preview's links and brand images use, so
 * they resolve on whichever host is serving it.
 */
export async function requirePreviewOwner(request: Request): Promise<string> {
  const url = new URL(request.url);
  const cookieStore = await cookies();
  const session = await verifyModeratorSession(cookieStore.get(MODERATOR_SESSION_COOKIE)?.value);
  if (!session) redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
  if (session.role !== "owner") redirect("/moderation");
  return requestOrigin(request);
}

/** The host the browser asked for; `request.url` can say localhost behind a proxy or `next start`. */
function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const first = (name: string) => request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const host = first("x-forwarded-host") ?? first("host") ?? url.host;
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

export const FAKE_SUBMISSION: Submission = {
  id: "sub-preview-0001",
  movieTitle: "Ratatouille",
  movieYear: 2007,
  imdbId: "tt0382932",
  imdbKind: "movie",
  timestamp: "42%",
  title: "Remy on the windowsill",
  description:
    "Remy peeks over the windowsill of Gusteau's kitchen, sniffing the air before vanishing back into the rain. Brief but unmistakable — small chittering audible at 41:58.",
  spoiler: false,
  approximateRatCount: 3,
  rodentTypes: ["mouse"],
  status: "pending",
  submittedBy: "Jordan Sterling",
  submitterEmail: "jordan@example.com",
  submittedAt: new Date(),
  images: [
    { url: "https://picsum.photos/seed/wr-1/240/240", alt: "" },
    { url: "https://picsum.photos/seed/wr-2/240/240", alt: "" },
    { url: "https://picsum.photos/seed/wr-3/240/240", alt: "" },
    { url: "https://picsum.photos/seed/wr-4/240/240", alt: "" },
  ],
};

const PREVIEWS = [
  { slug: "moderation", label: "Moderator", sublabel: "new sighting" },
  { slug: "submitter-receipt", label: "Submitter", sublabel: "receipt" },
  { slug: "submitter-approved", label: "Submitter", sublabel: "approved" },
  { slug: "submitter-declined", label: "Submitter", sublabel: "declined" },
  { slug: "newsletter", label: "Newsletter", sublabel: "news post" },
] as const;

export type PreviewSlug = (typeof PREVIEWS)[number]["slug"];

/** Injects a sticky preview-switcher nav bar into the email HTML. */
export function wrapWithPreviewNav(html: string, current: PreviewSlug): string {
  const options = PREVIEWS.map(({ slug, label, sublabel }) =>
    `<option value="/email-preview/${slug}"${slug === current ? " selected" : ""}>${label} — ${sublabel}</option>`
  ).join("");

  const nav = `<div style="
    position:sticky;top:0;z-index:100;
    background:#fff8ed;border-bottom:1px solid #e6dfd1;
    padding:8px 12px;display:flex;align-items:center;gap:8px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  ">
    <a href="/moderation" style="
      flex-shrink:0;padding:6px 10px;border-radius:8px;
      font-size:12px;font-weight:600;color:#57534e;text-decoration:none;
      display:inline-flex;align-items:center;gap:4px;white-space:nowrap;
    ">← Moderation</a>
    <select
      onchange="window.location.href=this.value"
      style="
        flex:1;min-width:0;height:34px;padding:0 10px;border-radius:8px;
        border:1px solid #d6cfc4;background:#fff;color:#1c1410;
        font-size:13px;font-weight:600;font-family:inherit;
        cursor:pointer;outline:none;appearance:none;
        background-image:url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22%2357534e%22><path d=%22M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z%22/></svg>');
        background-repeat:no-repeat;background-position:right 8px center;background-size:16px;
        padding-right:28px;
      "
    >
      ${options}
    </select>
  </div>`;

  return html.replace("<body", `<body data-preview-nav="true"`).replace(
    /(<body[^>]*>)/,
    `$1\n${nav}`,
  );
}
