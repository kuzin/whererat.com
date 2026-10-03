import { describe, it, expect, afterEach } from "vitest";
import { renderBrandedEmail, type BrandedEmail } from "@/lib/email-template";

const ATTACK = `"><script>alert(1)</script><img src=x onerror=alert(2)> & 'q'`;

function render(over: Partial<BrandedEmail> = {}) {
  return renderBrandedEmail({ heading: "Hello", blocks: [], ...over });
}

const savedSite = process.env.NEXT_PUBLIC_SITE_URL;
afterEach(() => {
  if (savedSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = savedSite;
});

describe("document shell", () => {
  it("renders a full HTML document with title, wordmark and footer", () => {
    const { html } = render();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Hello</title>");
    expect(html).toContain("/brand/email/wordmark.svg");
    expect(html).toContain("/brand/email/rat-amber.svg");
    expect(html).toContain("whererat.com");
  });

  it("uses the baseUrl override for brand links and the plain-text footer", () => {
    const { html, text } = render({ baseUrl: "https://staging.example" });
    expect(html).toContain('src="https://staging.example/brand/email/wordmark.svg"');
    expect(text).toContain("WhereRat · https://staging.example");
  });

  it("falls back to NEXT_PUBLIC_SITE_URL, then whererat.com", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://env.example";
    expect(render().html).toContain("https://env.example/brand/email/wordmark.svg");
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(render().html).toContain("https://whererat.com/brand/email/wordmark.svg");
  });

  it("default footer note is the moderator-team line; override replaces it", () => {
    expect(render().html).toContain("WhereRat moderation team");
    const { html } = render({ footerNote: "Custom note" });
    expect(html).toContain("Custom note");
    expect(html).not.toContain("moderation team");
  });

  it("renders the preheader only when given", () => {
    expect(render().html).not.toContain("display:none;max-height:0");
    expect(render({ preheader: "Preview" }).html).toContain("display:none;max-height:0");
  });
});

describe("escaping", () => {
  it("escapes heading, preheader, eyebrow, footer note and unsubscribe URL", () => {
    const { html } = render({
      heading: ATTACK,
      preheader: ATTACK,
      eyebrow: ATTACK,
      footerNote: ATTACK,
      footerUnsubscribeUrl: `https://x/u?t=${ATTACK}`,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;q&#39;");
  });

  it("escapes every built-in block type", () => {
    const { html } = render({
      blocks: [
        { kind: "heading", text: ATTACK },
        { kind: "paragraph", text: ATTACK },
        { kind: "keyValue", rows: [{ label: ATTACK, value: ATTACK }] },
        { kind: "quote", text: ATTACK },
        { kind: "gallery", images: [{ url: ATTACK, alt: ATTACK }] },
        { kind: "gallery", images: [{ url: ATTACK, alt: ATTACK }, { url: "/b.png" }] },
        { kind: "button", button: { label: ATTACK, href: ATTACK } },
        { kind: "button", button: { label: ATTACK, href: ATTACK, fullWidth: true } },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=alert(2)>");
  });

  it("escapes topMasthead heading/eyebrow and renders subhead markdown only after escaping", () => {
    const { html } = render({
      topMasthead: { heading: ATTACK, eyebrow: ATTACK, subhead: `**bold** _it_ ${ATTACK}` },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
  });

  it("an `html` block is passed through verbatim (caller-owned markup)", () => {
    const { html } = render({ blocks: [{ kind: "html", html: "<b id='raw'>x</b>" }] });
    expect(html).toContain("<b id='raw'>x</b>");
  });

  // Paragraph text is user-controlled in news digests (the post body). A body that
  // starts with "<span " is currently emitted as raw HTML instead of escaped.
  it("BUG: paragraph text starting with '<span ' bypasses escaping (HTML injection into emails)", () => {
    const { html } = render({
      blocks: [{ kind: "paragraph", text: `<span onmouseover="steal()">hi</span><img src=//evil.example/t.gif>` }],
    });
    expect(html).not.toContain("<img src=//evil.example/t.gif>");
  });
});

describe("blocks", () => {
  it("keyValue renders a row per pair", () => {
    const { html } = render({ blocks: [{ kind: "keyValue", rows: [{ label: "A", value: "1" }, { label: "B", value: "2" }] }] });
    expect(html.match(/<tr>\s*<td[^>]*>A<\/td>/)).toBeTruthy();
    expect(html).toContain(">2</td>");
  });

  it("quote preserves line breaks via pre-wrap", () => {
    const { html } = render({ blocks: [{ kind: "quote", text: "a\nb" }] });
    expect(html).toContain("white-space:pre-wrap");
    expect(html).toContain("a\nb");
  });

  it("a single-image gallery is a full-width hero", () => {
    const { html } = render({ blocks: [{ kind: "gallery", images: [{ url: "/one.png", alt: "One" }] }] });
    expect(html).toContain('height="216"');
    expect(html).toContain('alt="One"');
  });

  it("multi-image galleries render thumbnails, capped at five", () => {
    const images = Array.from({ length: 8 }, (_, i) => ({ url: `/i${i}.png` }));
    const { html } = render({ blocks: [{ kind: "gallery", images }] });
    expect(html.match(/width="104"/g)).toHaveLength(5);
    expect(html).not.toContain("/i5.png");
  });

  it("an empty gallery renders nothing", () => {
    const { html } = render({ blocks: [{ kind: "gallery", images: [] }] });
    expect(html).not.toContain('width="104"');
    expect(html).not.toContain('height="216"');
  });

  it("buttons: default is inline, fullWidth is block, centered wraps in an align=center cell", () => {
    const b = { kind: "button" as const, button: { label: "Go", href: "https://x/y" } };
    expect(render({ blocks: [b] }).html).toContain("display:inline-block;padding:10px 20px");
    expect(render({ blocks: [{ ...b, button: { ...b.button, fullWidth: true } }] }).html).toContain("display:block;padding:10px 20px");
    expect(render({ blocks: [b], centered: true }).html).toContain('<td align="center">');
  });

  it("divider renders a rule", () => {
    expect(render({ blocks: [{ kind: "divider" }] }).html).toContain("height:1px");
  });

  it("paragraph supports muted and custom margins", () => {
    const muted = render({ blocks: [{ kind: "paragraph", text: "m", muted: true }] }).html;
    expect(muted).toContain("#57534e");
    const margins = render({ blocks: [{ kind: "paragraph", text: "m", marginTop: 4, marginBottom: 9 }] }).html;
    expect(margins).toContain("margin:4px 0 9px;");
  });

  it("centered mode centres heading and paragraphs", () => {
    const { html } = render({ centered: true, blocks: [{ kind: "paragraph", text: "p" }] });
    expect(html.match(/text-align:center/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves block order", () => {
    const { html, text } = render({
      blocks: [
        { kind: "paragraph", text: "first" },
        { kind: "paragraph", text: "second" },
      ],
    });
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });
});

describe("masthead / emoji / eyebrow", () => {
  it("shows eyebrow, emoji and heading inside the card by default", () => {
    const { html } = render({ eyebrow: "New", emoji: "🐀" });
    expect(html).toContain("<h1");
    expect(html).toContain("🐀");
    expect(html).toContain(">New</p>");
  });

  it("topMasthead suppresses the in-card eyebrow, emoji and heading", () => {
    const { html } = render({
      eyebrow: "InCardEyebrow",
      emoji: "🧀",
      heading: "InCardHeading",
      topMasthead: { heading: "Masthead!" , emoji: "🐀", eyebrow: "Digest", subhead: "Sub" },
    });
    expect(html).not.toContain(">InCardEyebrow<");
    expect(html).not.toContain("🧀");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Masthead!");
    expect(html).toContain("Digest");
    // The document <title> still carries email.heading.
    expect(html).toContain("<title>InCardHeading</title>");
  });
});

describe("unsubscribe footer", () => {
  it("adds an unsubscribe link only when a URL is supplied", () => {
    expect(render().html).not.toContain("Unsubscribe");
    const { html, text } = render({ footerUnsubscribeUrl: "https://x/u?t=1" });
    expect(html).toContain('href="https://x/u?t=1"');
    expect(html).toContain("Unsubscribe</a>");
    expect(text).toContain("Unsubscribe: https://x/u?t=1");
  });
});

describe("plain-text part", () => {
  it("includes eyebrow (upper-cased), heading and footer", () => {
    const { text } = render({ eyebrow: "new", heading: "Hello" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("NEW");
    expect(lines[1]).toBe("Hello");
    expect(text).toContain("WhereRat · https://");
  });

  it("renders each block type as readable text", () => {
    const { text } = render({
      blocks: [
        { kind: "heading", text: "Sec" },
        { kind: "paragraph", text: "para" },
        { kind: "keyValue", rows: [{ label: "K", value: "V" }] },
        { kind: "quote", text: "l1\nl2" },
        { kind: "gallery", images: [{ url: "/a" }] },
        { kind: "gallery", images: [{ url: "/a" }, { url: "/b" }] },
        { kind: "gallery", images: [] },
        { kind: "button", button: { label: "Go", href: "https://x" } },
        { kind: "divider" },
        { kind: "html", html: "<b>x</b>", text: "plain x" },
        { kind: "html", html: "<b>y</b>" },
      ],
    });
    expect(text).toContain("Sec\n---");
    expect(text).toContain("para");
    expect(text).toContain("K: V");
    expect(text).toContain("> l1\n> l2");
    expect(text).toContain("(1 image attached");
    expect(text).toContain("(2 images attached");
    expect(text).toContain("Go: https://x");
    expect(text).toContain("---");
    expect(text).toContain("plain x");
    expect(text).not.toContain("<b>");
  });

  it("text carries no HTML for plain content", () => {
    const { text } = render({
      blocks: [{ kind: "paragraph", text: "Hello <world>" }],
    });
    // Plain text is not entity-escaped.
    expect(text).toContain("Hello <world>");
    expect(text).not.toContain("&lt;");
  });

  it("uses the topMasthead heading and subhead (not the card heading) in text", () => {
    const { text } = render({
      heading: "CardHeading",
      topMasthead: { eyebrow: "dig", heading: "MastHead", subhead: "Subby" },
    });
    expect(text.split("\n").slice(0, 3)).toEqual(["DIG", "MastHead", "Subby"]);
    expect(text).not.toContain("CardHeading");
  });

  it("mentions every button target present in the HTML (html/text parity)", () => {
    const hrefs = ["https://a.example/1", "https://b.example/2"];
    const { html, text } = render({
      blocks: hrefs.map((href, i) => ({ kind: "button" as const, button: { label: `B${i}`, href } })),
    });
    for (const href of hrefs) {
      expect(html).toContain(href);
      expect(text).toContain(href);
    }
  });

  it("the tag/date chip is plain text in the text part and escaped (never raw markup) in the HTML", () => {
    const { text, html } = render({
      blocks: [
        {
          kind: "meta",
          label: "Announcement",
          date: "May 1, 2026",
          colors: { bg: "#e0edff", color: "#1e40af", border: "#93c5fd" },
        },
      ],
    });
    expect(text).toContain("Announcement · May 1, 2026");
    expect(text).not.toContain("<span");
    expect(html).toContain(">Announcement</span>");
  });

  it("meta label, date and colours cannot inject markup or break out of the style attribute", () => {
    const { html } = render({
      blocks: [
        {
          kind: "meta",
          label: '<img src=//evil.example/t.gif>',
          date: '"><script>alert(1)</script>',
          colors: { bg: 'red;"><img src=x onerror=alert(1)>', color: "#000", border: "#000" },
        },
      ],
    });
    expect(html).not.toContain("<img src=//evil.example");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("onerror=alert(1)>");
  });

  it("the footer note is repeated in the plain-text part (it carries the unsubscribe link)", () => {
    const { text } = render({ blocks: [], footerNote: "Unsubscribe: https://whererat.com/u?token=abc" });
    expect(text).toContain("Unsubscribe: https://whererat.com/u?token=abc");
  });
});
