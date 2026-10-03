/**
 * Branded HTML/text shell for transactional emails. Inline styles + table layout
 * for broad email-client compatibility (Gmail, Apple Mail, Outlook). Logo and
 * rat mark are served as SVGs from `public/brand/email/` via absolute URLs.
 */

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://whererat.com";
}

const C = {
  bg: "#fff8ed",
  card: "#ffffff",
  border: "#e6dfd1",
  borderSoft: "#efe7d6",
  text: "#1c1410",
  muted: "#57534e",
  accent: "#ea580c",
  accentHover: "#c2410c",
  amber: "#a16207",
  panelBg: "#fef9ec",
  panelBorder: "#f1d9a8",
};

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type EmailButton = {
  label: string;
  href: string;
  fullWidth?: boolean;
};

export type EmailImage = {
  url: string;
  alt?: string;
};

export type EmailContentBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string; muted?: boolean; marginTop?: number; marginBottom?: number }
  /** A coloured label chip plus a date ("Announcement  May 1, 2026"). All values are escaped. */
  | { kind: "meta"; label: string; date?: string; colors: { bg: string; color: string; border: string }; marginTop?: number; marginBottom?: number }
  | { kind: "keyValue"; rows: Array<{ label: string; value: string }> }
  | { kind: "quote"; text: string }
  | { kind: "gallery"; images: EmailImage[] }
  | { kind: "button"; button: EmailButton }
  | { kind: "divider" }
  | { kind: "html"; html: string; text?: string };

export type BrandedEmail = {
  /** Pre-header text — shows in the inbox preview line, hidden in the body. */
  preheader?: string;
  /** Short kicker shown above the heading (e.g. "New submission"). */
  eyebrow?: string;
  heading: string;
  blocks: EmailContentBlock[];
  /** Optional large emoji shown centered at the top of the card, above the heading. */
  emoji?: string;
  /** When true, center all paragraph and button content inside the card. */
  centered?: boolean;
  /** Footer disclaimer line. Defaults to the moderator-team note. */
  footerNote?: string;
  /** Adds an "opted in … Unsubscribe" line under the footer note, with a real link. */
  footerUnsubscribeUrl?: string;
  /** Override the base URL used for brand image links (defaults to siteUrl()). */
  baseUrl?: string;
  /**
   * Optional centered masthead rendered OUTSIDE the card, between the
   * wordmark and the card body. Used by digest-style emails so the section
   * title doesn't compete visually with the first item's heading inside
   * the card. When set, the inside-card eyebrow/heading are suppressed
   * (the document <title> still uses `email.heading`).
   */
  topMasthead?: {
    emoji?: string;
    eyebrow?: string;
    heading: string;
    subhead?: string;
  };
};

function renderInlineMarkdown(input: string): string {
  return escapeHtml(input)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

const OPTED_IN_LINE = "You also opted in to our news feed.";

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBlock(block: EmailContentBlock, centered?: boolean): string {
  switch (block.kind) {
    case "heading":
      return `<h2 style="margin:0 0 12px;font-family:${FONT_STACK};font-size:20px;line-height:1.3;color:${C.text};font-weight:700">${escapeHtml(block.text)}</h2>`;
    case "paragraph": {
      const marginTop = typeof block.marginTop === "number" ? block.marginTop : 0;
      const marginBottom = typeof block.marginBottom === "number" ? block.marginBottom : 14;
      const marginStyle = marginTop === 0 && marginBottom === 14 ? "" : `margin:${marginTop}px 0 ${marginBottom}px;`;
      const baseStyle = `${marginStyle || "margin:0 0 14px;"}font-family:${FONT_STACK};font-size:15px;line-height:1.55;color:${block.muted ? C.muted : C.text}${centered ? ";text-align:center" : ""}`;
      // Always escaped: paragraph text may come from owner/public input.
      return `<p style="${baseStyle}">${escapeHtml(block.text)}</p>`;
    }
    case "meta": {
      const marginTop = block.marginTop ?? 0;
      const marginBottom = block.marginBottom ?? 14;
      // Colours are interpolated into a style attribute, so only plain colour tokens are allowed.
      const safeColor = (value: string) => (/^[#a-zA-Z0-9(),.%\s-]{1,60}$/.test(value) ? value : "#888888");
      const { bg, color, border } = block.colors;
      return `<p style="margin:${marginTop}px 0 ${marginBottom}px;font-family:${FONT_STACK}${centered ? ";text-align:center" : ""}"><span style="display:inline-block;padding:2px 10px 2px 8px;font-size:12px;font-weight:700;border-radius:8px;background:${safeColor(bg)};color:${safeColor(color)};border:1px solid ${safeColor(border)};margin-right:8px;vertical-align:middle;">${escapeHtml(block.label)}</span>${block.date ? `<span style="font-size:13px;color:#888;vertical-align:middle;">${escapeHtml(block.date)}</span>` : ""}</p>`;
    }
    case "keyValue": {
      const rowsHtml = block.rows
        .map(
          (r) => `
            <tr>
              <td style="padding:6px 14px 6px 0;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:${C.muted};white-space:nowrap;vertical-align:top">${escapeHtml(r.label)}</td>
              <td style="padding:6px 0;font-family:${FONT_STACK};font-size:14px;line-height:1.5;color:${C.text};vertical-align:top">${escapeHtml(r.value)}</td>
            </tr>`,
        )
        .join("");
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;border-collapse:collapse">
          ${rowsHtml}
        </table>`;
    }
    case "quote":
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;border-collapse:collapse">
          <tr>
            <td style="padding:14px 16px;background:${C.panelBg};border-left:3px solid ${C.accent};border-radius:4px;font-family:${FONT_STACK};font-size:14px;line-height:1.6;color:${C.text};white-space:pre-wrap">${escapeHtml(block.text)}</td>
          </tr>
        </table>`;
    case "gallery": {
      // If only one image, render as a full-width hero image (newsletter style)
      if (block.images.length === 1) {
        const img = block.images[0];
        return `
          <div style="margin:0 0 24px 0;width:100%">
            <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt ?? "")}" width="544" height="216" style="display:block;width:100%;max-width:544px;height:216px;object-fit:cover;border-radius:18px;border:1px solid ${C.borderSoft};outline:none;margin:0 auto">
          </div>`;
      }
      // Otherwise, render as a row of thumbnails (moderation style)
      const images = block.images.slice(0, 5);
      if (!images.length) return "";
      const cells = images
        .map(
          (img) => `
            <td valign="top" style="padding:0 6px 0 0;vertical-align:top">
              <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt ?? "")}" width="104" height="104" style="display:block;width:104px;height:104px;object-fit:cover;border-radius:10px;border:1px solid ${C.borderSoft};outline:none">
            </td>`,
        )
        .join("");
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 18px;border-collapse:separate">
          <tr>${cells}</tr>
        </table>`;
    }
    case "button":
      if (centered) {
        return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 12px;border-collapse:collapse">
            <tr><td align="center">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0">
                <tr>
                  <td style="background:${C.accent};border:2px solid #0c0a09;border-radius:12px;box-shadow:3px 3px 0 0 rgba(87,83,78,0.5)">
                    <a href="${escapeHtml(block.button.href)}" style="display:inline-block;padding:10px 20px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:-0.005em">${escapeHtml(block.button.label)}</a>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>`;
      }
      if (block.button.fullWidth) {
        return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 12px;border-collapse:separate;border-spacing:0">
            <tr>
              <td style="background:${C.accent};border:2px solid #0c0a09;border-radius:12px;box-shadow:3px 3px 0 0 rgba(87,83,78,0.5)">
                <a href="${escapeHtml(block.button.href)}" style="display:block;padding:10px 20px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:-0.005em;text-align:center">${escapeHtml(block.button.label)}</a>
              </td>
            </tr>
          </table>`;
      }
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 12px;border-collapse:separate;border-spacing:0">
          <tr>
            <td style="background:${C.accent};border:2px solid #0c0a09;border-radius:12px;box-shadow:3px 3px 0 0 rgba(87,83,78,0.5)">
              <a href="${escapeHtml(block.button.href)}" style="display:inline-block;padding:10px 20px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:-0.005em">${escapeHtml(block.button.label)}</a>
            </td>
          </tr>
        </table>`;
    case "divider":
      return `<div style="height:1px;background:${C.borderSoft};margin:18px 0"></div>`;
    case "html":
      return block.html;
  }
}

function blockToText(block: EmailContentBlock): string {
  switch (block.kind) {
    case "heading":
      return `\n${block.text}\n${"-".repeat(Math.min(block.text.length, 40))}`;
    case "paragraph":
      return block.text;
    case "meta":
      return block.date ? `${block.label} · ${block.date}` : block.label;
    case "keyValue":
      return block.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
    case "quote":
      return block.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "gallery":
      return block.images.length
        ? `(${block.images.length} image${block.images.length === 1 ? "" : "s"} attached — view in the moderation queue)`
        : "";
    case "button":
      return `${block.button.label}: ${block.button.href}`;
    case "divider":
      return "---";
    case "html":
      return block.text ?? "";
  }
}

export function renderBrandedEmail(email: BrandedEmail): { html: string; text: string } {
  const SITE = email.baseUrl ?? siteUrl();
  const blocksHtml = email.blocks.map((b) => renderBlock(b, email.centered)).join("\n");
  const wordmarkUrl = `${SITE}/brand/email/wordmark.svg`;
  const ratUrl = `${SITE}/brand/email/rat-amber.svg`;
  const preheader = email.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};opacity:0">${escapeHtml(email.preheader)}</div>`
    : "";
  const useTopMasthead = Boolean(email.topMasthead);
  const eyebrow = !useTopMasthead && email.eyebrow
    ? `<p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:11px;line-height:1.2;color:${C.accent};letter-spacing:0.08em;text-transform:uppercase;font-weight:600">${escapeHtml(email.eyebrow)}</p>`
    : "";
  const cardIcon = !useTopMasthead && email.emoji
    ? `<div style="text-align:center;padding:4px 0 16px;font-size:60px;line-height:1">${email.emoji}</div>`
    : "";
  const insideHeading = useTopMasthead
    ? ""
    : `<h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;line-height:1.3;color:${C.text};font-weight:700${email.centered ? ";text-align:center" : ""}">${escapeHtml(email.heading)}</h1>`;
  const topMasthead = useTopMasthead && email.topMasthead
    ? `
            <!-- Top masthead (digest style — sits outside the card) -->
            <tr>
              <td align="center" style="padding:8px 16px 22px;font-family:${FONT_STACK}">
                ${email.topMasthead.emoji ? `<div style="font-size:44px;line-height:1;margin-bottom:10px" aria-hidden="true">${email.topMasthead.emoji}</div>` : ""}
                ${email.topMasthead.eyebrow ? `<p style="margin:0 0 6px;font-size:11px;line-height:1.2;color:${C.accent};letter-spacing:0.10em;text-transform:uppercase;font-weight:700">${escapeHtml(email.topMasthead.eyebrow)}</p>` : ""}
                <h1 style="margin:0;font-family:${FONT_STACK};font-size:26px;line-height:1.25;color:${C.text};font-weight:800;letter-spacing:-0.01em">${escapeHtml(email.topMasthead.heading)}</h1>
                ${email.topMasthead.subhead ? `<p style="margin:8px 0 0;font-size:14px;line-height:1.4;color:${C.muted}">${renderInlineMarkdown(email.topMasthead.subhead)}</p>` : ""}
              </td>
            </tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${escapeHtml(email.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${C.bg};color:${C.text};font-family:${FONT_STACK}">
    ${preheader}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.bg};border-collapse:collapse">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0">

            <!-- Header / wordmark -->
            <tr>
              <td align="center" style="padding:4px 0 20px">
                <a href="${SITE}" style="text-decoration:none;display:inline-block">
                  <img src="${wordmarkUrl}" alt="WhereRat" width="160" height="38" style="display:block;width:160px;height:auto;border:0;outline:none">
                </a>
              </td>
            </tr>

            ${topMasthead}

            <!-- Card -->
            <tr>
              <td style="background:${C.card};border:1px solid ${C.border};border-radius:18px;padding:28px 28px 24px">
                ${cardIcon}${eyebrow}
                ${insideHeading}
                ${blocksHtml}
              </td>
            </tr>

            <!-- Footer pill (clickable to whererat.com) -->
            <tr>
              <td align="center" style="padding:24px 0 6px">
                <a href="${SITE}" style="display:block;text-decoration:none;color:inherit">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0">
                    <tr>
                      <td style="background:${C.card};border:1px solid ${C.border};border-radius:18px;padding:14px 20px">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
                          <tr>
                            <td width="44" valign="middle" style="vertical-align:middle;width:44px;padding-right:12px;text-align:left">
                              <img src="${ratUrl}" alt="" width="36" height="31" style="display:block;width:36px;height:auto;border:0;outline:none">
                            </td>
                            <td valign="middle" style="vertical-align:middle;font-family:${FONT_STACK};text-align:left">
                              <div style="font-family:${FONT_STACK};font-size:15px;line-height:1.2;color:${C.text};font-weight:700;letter-spacing:-0.01em">whererat.com</div>
                              <div style="margin-top:3px;font-family:${FONT_STACK};font-size:12px;line-height:1.4;color:${C.muted}">A spoiler-aware catalog of rat cameos in film &amp; TV.</div>
                            </td>
                            <td width="20" valign="middle" align="right" style="vertical-align:middle;width:20px;text-align:right;font-family:${FONT_STACK};font-size:22px;line-height:1;color:${C.muted};padding-left:8px">
                              &rsaquo;
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:4px 16px 0">
                <p style="margin:8px 0 0;font-family:${FONT_STACK};font-size:11px;line-height:1.5;color:${C.muted}">
                  ${escapeHtml(email.footerNote ?? "You're receiving this because you're on the WhereRat moderation team.")}${
                    email.footerUnsubscribeUrl
                      ? `<br><br><span style="font-size:11px">${escapeHtml(OPTED_IN_LINE)} <a href="${escapeHtml(email.footerUnsubscribeUrl)}" style="color:inherit;text-decoration:underline">Unsubscribe</a>.</span>`
                      : ""
                  }
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textParts = useTopMasthead && email.topMasthead
    ? [
        email.topMasthead.eyebrow ? email.topMasthead.eyebrow.toUpperCase() : null,
        email.topMasthead.heading,
        email.topMasthead.subhead ?? null,
        "",
        ...email.blocks.map(blockToText),
        "",
        "—",
        `WhereRat · ${SITE}`,
      ].filter((x): x is string => x !== null)
    : [
        email.eyebrow ? email.eyebrow.toUpperCase() : null,
        email.heading,
        "",
        ...email.blocks.map(blockToText),
        "",
        "—",
        `WhereRat · ${SITE}`,
      ].filter((x): x is string => x !== null);
  if (email.footerUnsubscribeUrl) {
    textParts.push("", `${OPTED_IN_LINE} Unsubscribe: ${email.footerUnsubscribeUrl}`);
  }
  // The footer holds the "why you got this" line and, for newsletters, the unsubscribe URL.
  if (email.footerNote) textParts.push("", email.footerNote);
  const text = textParts.join("\n");

  return { html, text };
}
