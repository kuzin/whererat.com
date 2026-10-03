/**
 * news-notify.ts: single-post newsletter builder, fan-out to subscribers, the
 * digest sender and the test-send. Complements news-notify.test.ts (digest
 * subject / basic rendering). Email transport, subscriber store and send log
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(),
  getMarketingSubscribers: vi.fn(),
  getSubscriber: vi.fn(),
  recordNewsletterSend: vi.fn(),
}));
vi.mock("@/lib/email-send", () => ({ sendBrandedEmail: h.send }));
vi.mock("@/lib/email-preferences-store", () => ({
  getMarketingSubscribers: h.getMarketingSubscribers,
  getSubscriber: h.getSubscriber,
}));
vi.mock("@/lib/newsletter-sends-store", () => ({ recordNewsletterSend: h.recordNewsletterSend }));

import {
  buildNewsletterEmail,
  buildNewsletterDigestEmail,
  sendNewsletterToSubscribers,
  sendDigestNewsletterToSubscribers,
  sendDigestNewsletterTest,
} from "@/lib/news-notify";
import type { NewsItem } from "@/lib/news-store";

function item(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "news-1",
    title: "Hello rat fans",
    body: "Line one\nLine two",
    type: "announcement",
    imageUrl: null,
    imageAlt: null,
    imagePositionX: 50,
    imagePositionY: 50,
    imageZoom: 1,
    authorId: "a",
    authorName: "Admin",
    authorAvatarUrl: "",
    publishedAt: new Date("2026-05-01T12:00:00Z"),
    createdAt: new Date("2026-04-01T12:00:00Z"),
    updatedAt: new Date("2026-05-01T12:00:00Z"),
    ...over,
  };
}

const ENV = ["NEXT_PUBLIC_SITE_URL", "NEWSLETTER_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.values(h).forEach((m) => m.mockReset());
  h.send.mockResolvedValue(undefined);
  h.getMarketingSubscribers.mockResolvedValue([]);
  h.getSubscriber.mockResolvedValue(undefined);
  h.recordNewsletterSend.mockResolvedValue("nl-1");
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sent = () =>
  h.send.mock.calls.map(
    ([a]) => a as { to: string; subject: string; html: string; text: string; from: string; headers: Record<string, string>; logTag: string },
  );

describe("buildNewsletterEmail", () => {
  it("uses the post title as subject and links to the article", () => {
    const out = buildNewsletterEmail(item({ id: "news a/b" }), "tok");
    expect(out.subject).toBe("Hello rat fans");
    expect(out.html).toContain("https://whererat.com/news?post=news%20a%2Fb");
    expect(out.text).toContain("Read on WhereRat: https://whererat.com/news?post=news%20a%2Fb");
  });

  it("puts a real, token-encoded unsubscribe link in the HTML footer and the text", () => {
    const out = buildNewsletterEmail(item(), "to ken&1");
    const url = "https://whererat.com/api/unsubscribe?token=to%20ken%261";
    expect(out.html).toContain(`<a href="${url}"`);
    expect(out.html).not.toContain(`Unsubscribe: ${url}`);
  });

  // The HTML footer carries an unsubscribe link but the text/plain alternative has none
  // (footerNote / footerUnsubscribeUrl only reach the HTML), so text-only readers get no
  // in-body opt-out. The List-Unsubscribe header is the only remaining route.
  it("BUG: the plain-text part of a newsletter has no unsubscribe link", () => {
    const out = buildNewsletterEmail(item(), "tok");
    expect(out.text).toContain("/api/unsubscribe?token=tok");
  });

  it("BUG: the plain-text part of a digest has no unsubscribe link", () => {
    const out = buildNewsletterDigestEmail([item()], "tok", "S");
    expect(out.text).toContain("/api/unsubscribe?token=tok");
  });

  it("honours a base URL override everywhere", () => {
    const out = buildNewsletterEmail(item(), "t", "https://stage.example");
    expect(out.html).toContain("https://stage.example/news?post=news-1");
    expect(out.html).toContain("https://stage.example/api/unsubscribe?token=t");
  });

  it("shows a type chip with a readable label and the published date", () => {
    const out = buildNewsletterEmail(item({ type: "product-news" }), "t");
    expect(out.html).toContain("Product news");
    expect(out.html).toContain("May 1, 2026");
  });

  it("falls back to createdAt when unpublished, and to no date for non-Date values", () => {
    expect(buildNewsletterEmail(item({ publishedAt: null }), "t").html).toContain("April 1, 2026");
    const odd = item({ publishedAt: null, createdAt: "2026-01-01" as unknown as Date });
    expect(() => buildNewsletterEmail(odd, "t")).not.toThrow();
  });

  it("unknown types render using the raw type label and the 'update' colours", () => {
    const out = buildNewsletterEmail(item({ type: "mystery" as never }), "t");
    expect(out.html).toContain("mystery");
    expect(out.html).toContain("#f5f5f4");
  });

  it("truncates the body preview to four lines with an ellipsis", () => {
    const body = ["1", "2", "3", "4", "5", "6"].map((n) => `line-${n}`).join("\n");
    const { text } = buildNewsletterEmail(item({ body }), "t");
    expect(text).toContain("line-4");
    expect(text).not.toContain("line-5");
    expect(text).toContain("…");
  });

  it("does not add an ellipsis for short bodies; handles CRLF", () => {
    const { text } = buildNewsletterEmail(item({ body: "a\r\nb\r\nc" }), "t");
    expect(text).not.toContain("…");
    expect(text).toContain("a\r\nb\r\nc".replace(/\r/g, ""));
  });

  it("includes the hero image (with fallback alt) when present", () => {
    const withAlt = buildNewsletterEmail(item({ imageUrl: "https://img/x.png", imageAlt: "Alt" }), "t");
    expect(withAlt.html).toContain("https://img/x.png");
    expect(withAlt.html).toContain('alt="Alt"');
    const noAlt = buildNewsletterEmail(item({ imageUrl: "https://img/x.png" }), "t");
    expect(noAlt.html).toContain('alt="News image"');
  });

  it("escapes hostile title/body/image fields", () => {
    const evil = `<script>alert(1)</script>`;
    const out = buildNewsletterEmail(item({ title: evil, body: `x ${evil}`, imageUrl: `https://i/"${evil}`, imageAlt: evil }), "t");
    expect(out.html).not.toContain(evil);
  });

  it("preheader is capped at 120 chars of body", () => {
    const out = buildNewsletterEmail(item({ body: "x".repeat(500) }), "t");
    const preheader = /mso-hide:all[^>]*>(x+)<\/div>/.exec(out.html)?.[1];
    expect(preheader).toHaveLength(120);
  });

  it("BUG: plain-text part contains the raw <span> markup of the type chip / date line", () => {
    const out = buildNewsletterEmail(item(), "t");
    expect(out.text).not.toContain("<span");
  });
});

describe("buildNewsletterDigestEmail", () => {
  it("separates multiple items with dividers and numbers the read-more links", () => {
    const out = buildNewsletterDigestEmail(
      [item({ id: "a", title: "A" }), item({ id: "b", title: "B" })],
      "t",
      "Subj",
    );
    expect(out.html).toContain("/news?post=a");
    expect(out.html).toContain("/news?post=b");
    expect(out.text).toContain("Read more: https://whererat.com/news?post=a");
    expect(out.html.match(/height:1px;background/g)).toHaveLength(1);
  });

  it("uses overrides for heading and subhead and trims them", () => {
    const out = buildNewsletterDigestEmail([item()], "t", "S", undefined, "  Big Heading ", "  Sub **bold** ");
    expect(out.html).toContain("Big Heading");
    expect(out.html).toContain("<strong>bold</strong>");
    expect(out.text.split("\n")[0]).toBe("Big Heading");
  });

  it("derives default heading/subhead from item count", () => {
    const single = buildNewsletterDigestEmail([item({ title: "Solo" })], "t", "S");
    expect(single.html).toContain("A fresh update from the WhereRat catalog.");
    const multi = buildNewsletterDigestEmail([item({ id: "a" }), item({ id: "b" })], "t", "S");
    expect(multi.html).toContain("Fresh from WhereRat");
    expect(multi.html).toContain("2 new updates from the WhereRat catalog.");
  });

  it("renders without throwing for an empty item list", () => {
    expect(() => buildNewsletterDigestEmail([], "t", "S")).not.toThrow();
  });

  it("encodes the unsubscribe token", () => {
    const out = buildNewsletterDigestEmail([item()], "a b&c", "S");
    expect(out.html).toContain("token=a%20b%26c");
  });

  it("escapes hostile fields", () => {
    const evil = `<script>alert(1)</script>`;
    const out = buildNewsletterDigestEmail([item({ title: evil, body: `b ${evil}` })], "t", "S", undefined, evil, evil);
    expect(out.html).not.toContain(evil);
  });

  it("BUG: a body that starts with '<span ' is emitted as raw HTML to every subscriber", () => {
    const out = buildNewsletterDigestEmail(
      [item({ body: `<span style="x">hi</span><img src=//evil.example/pixel.gif>` })],
      "t",
      "S",
    );
    expect(out.html).not.toContain("<img src=//evil.example/pixel.gif>");
  });
});

describe("sendNewsletterToSubscribers", () => {
  it("does nothing without subscribers", async () => {
    await sendNewsletterToSubscribers(item());
    expect(h.send).not.toHaveBeenCalled();
  });

  it("sends one email per subscriber with their own unsubscribe link and list headers", async () => {
    h.getMarketingSubscribers.mockResolvedValue([
      { email: "a@x.com", unsubscribeToken: "ta" },
      { email: "b@x.com", unsubscribeToken: "tb" },
    ]);
    await sendNewsletterToSubscribers(item());
    const calls = sent();
    expect(calls.map((c) => c.to)).toEqual(["a@x.com", "b@x.com"]);
    expect(calls[0]!.html).toContain("token=ta");
    expect(calls[0]!.html).not.toContain("token=tb");
    expect(calls[1]!.html).toContain("token=tb");
    expect(calls[0]!.headers["List-Unsubscribe"]).toContain("token=ta");
    expect(calls[0]!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(calls[0]!.from).toBe("WhereRat News <news@whererat.com>");
    expect(calls[0]!.logTag).toBe("newsletter");
  });

  it("uses NEWSLETTER_FROM when set", async () => {
    process.env.NEWSLETTER_FROM = "Custom <c@x.com>";
    h.getMarketingSubscribers.mockResolvedValue([{ email: "a@x.com", unsubscribeToken: "t" }]);
    await sendNewsletterToSubscribers(item());
    expect(sent()[0]!.from).toBe("Custom <c@x.com>");
  });

  it("keeps sending to the rest when one send rejects", async () => {
    h.getMarketingSubscribers.mockResolvedValue([
      { email: "a@x.com", unsubscribeToken: "ta" },
      { email: "b@x.com", unsubscribeToken: "tb" },
    ]);
    h.send.mockRejectedValueOnce(new Error("boom"));
    await expect(sendNewsletterToSubscribers(item())).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

describe("sendDigestNewsletterToSubscribers", () => {
  const mod = { id: "m1", name: "Mo" };

  it("returns zero and sends nothing for no items", async () => {
    expect(await sendDigestNewsletterToSubscribers([], mod, "S")).toEqual({ recipientCount: 0, sendId: null });
    expect(h.getMarketingSubscribers).not.toHaveBeenCalled();
  });

  it("returns zero without recording a send when nobody is subscribed", async () => {
    expect(await sendDigestNewsletterToSubscribers([item()], mod, "S")).toEqual({ recipientCount: 0, sendId: null });
    expect(h.recordNewsletterSend).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("records the send before fanning out, then emails each subscriber", async () => {
    const order: string[] = [];
    h.getMarketingSubscribers.mockResolvedValue([
      { email: "a@x.com", unsubscribeToken: "ta" },
      { email: "b@x.com", unsubscribeToken: "tb" },
    ]);
    h.recordNewsletterSend.mockImplementation(async () => {
      order.push("record");
      return "nl-9";
    });
    h.send.mockImplementation(async () => {
      order.push("send");
    });
    const out = await sendDigestNewsletterToSubscribers(
      [item({ id: "n1" }), item({ id: "n2" })],
      mod,
      "Digest subject",
      "Head",
      "Sub",
    );
    expect(out).toEqual({ recipientCount: 2, sendId: "nl-9" });
    expect(order).toEqual(["record", "send", "send"]);
    expect(h.recordNewsletterSend).toHaveBeenCalledWith({
      subject: "Digest subject",
      sentById: "m1",
      sentByName: "Mo",
      recipientCount: 2,
      newsItemIds: ["n1", "n2"],
    });
    const calls = sent();
    expect(calls[0]).toMatchObject({ to: "a@x.com", subject: "Digest subject", logTag: "newsletter-digest" });
    expect(calls[0]!.html).toContain("Head");
    expect(calls[0]!.html).toContain("token=ta");
    expect(calls[1]!.html).toContain("token=tb");
  });

  it("does not email anyone if recording the send fails", async () => {
    h.getMarketingSubscribers.mockResolvedValue([{ email: "a@x.com", unsubscribeToken: "t" }]);
    h.recordNewsletterSend.mockRejectedValue(new Error("db"));
    await expect(sendDigestNewsletterToSubscribers([item()], mod, "S")).rejects.toThrow("db");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("individual send failures do not fail the batch", async () => {
    h.getMarketingSubscribers.mockResolvedValue([
      { email: "a@x.com", unsubscribeToken: "ta" },
      { email: "b@x.com", unsubscribeToken: "tb" },
    ]);
    h.send.mockRejectedValueOnce(new Error("smtp"));
    const out = await sendDigestNewsletterToSubscribers([item()], mod, "S");
    expect(out.recipientCount).toBe(2);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

describe("sendDigestNewsletterTest", () => {
  it("is a no-op without items or recipient", async () => {
    expect(await sendDigestNewsletterTest([], "a@x.com", "S")).toEqual({ delivered: false });
    expect(await sendDigestNewsletterTest([item()], "", "S")).toEqual({ delivered: false });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("prefixes the subject with [TEST] and uses a dummy token for non-subscribers", async () => {
    const out = await sendDigestNewsletterTest([item()], "me@x.com", "Subj");
    expect(out).toEqual({ delivered: true });
    const [call] = sent();
    expect(call).toMatchObject({ to: "me@x.com", subject: "[TEST] Subj", logTag: "newsletter-digest-test" });
    expect(call!.html).toContain("token=test-preview");
    expect(call!.headers["List-Unsubscribe"]).toContain("token=test-preview");
  });

  it("uses the recipient's real token when they are a subscriber", async () => {
    h.getSubscriber.mockResolvedValue({ email: "me@x.com", unsubscribeToken: "real-tok" });
    await sendDigestNewsletterTest([item()], "me@x.com", "Subj");
    expect(sent()[0]!.html).toContain("token=real-tok");
  });

  it("never records a newsletter send or contacts the subscriber list", async () => {
    await sendDigestNewsletterTest([item()], "me@x.com", "Subj");
    expect(h.recordNewsletterSend).not.toHaveBeenCalled();
    expect(h.getMarketingSubscribers).not.toHaveBeenCalled();
  });
});
