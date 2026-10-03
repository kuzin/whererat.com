/**
 * /email-preview/* route handlers: owner only (they used to 404 in production, which
 * also blanked the newsletter composer's live preview), with links and brand images on
 * the serving host instead of a hard-coded localhost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    session: null as null | { id: string; name: string; role: "owner" | "moderator" },
    newsItem: undefined as unknown,
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "signed" }) })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("@/lib/auth", () => ({ MODERATOR_SESSION_COOKIE: "whererat_moderator" }));
vi.mock("@/lib/moderator-session", () => ({ verifyModeratorSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/news-store", () => ({ getNewsItemById: vi.fn(async () => h.newsItem) }));

import { GET as newsletter } from "@/app/email-preview/newsletter/route";
import { GET as moderation } from "@/app/email-preview/moderation/route";
import { GET as receipt } from "@/app/email-preview/submitter-receipt/route";
import { GET as approved } from "@/app/email-preview/submitter-approved/route";
import { GET as declined } from "@/app/email-preview/submitter-declined/route";

const ORIGIN = "https://whererat.example";
const ROUTES = [
  ["newsletter", newsletter],
  ["moderation", moderation],
  ["submitter-receipt", receipt],
  ["submitter-approved", approved],
  ["submitter-declined", declined],
] as const;

async function call(handler: (request: Request) => Promise<Response>, path: string) {
  try {
    return { response: await handler(new Request(`${ORIGIN}${path}`)) };
  } catch (e) {
    if (e instanceof h.RedirectSignal) return { redirect: e.url };
    throw e;
  }
}

beforeEach(() => {
  h.session = { id: "acct-admin", name: "Admin", role: "owner" };
  h.newsItem = undefined;
});

describe.each(ROUTES)("/email-preview/%s", (slug, handler) => {
  const path = `/email-preview/${slug}`;

  it("sends a signed-out visitor to log in, coming back here", async () => {
    h.session = null;
    expect(await call(handler, path)).toEqual({ redirect: `/login?next=${encodeURIComponent(path)}` });
  });

  it("turns away a moderator who is not the owner", async () => {
    h.session = { id: "acct-mod", name: "Mod", role: "moderator" };
    expect(await call(handler, path)).toEqual({ redirect: "/moderation" });
  });

  it("renders for the owner, with links and brand images on the serving host", async () => {
    const { response } = await call(handler, path);
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await response!.text();
    expect(html).toContain(`${ORIGIN}/brand/email/wordmark.svg`);
    expect(html).not.toContain("localhost");
  });
});

describe("preview origin", () => {
  const wordmarkOf = async (headers: Record<string, string>) => {
    const response = await moderation(new Request(`http://localhost:3000/email-preview/moderation`, { headers }));
    return (await response.text()).match(/src="([^"]*wordmark\.svg)"/)?.[1];
  };

  it("follows the Host header when request.url says localhost", async () => {
    expect(await wordmarkOf({ host: "127.0.0.1:3200" })).toBe("http://127.0.0.1:3200/brand/email/wordmark.svg");
  });

  it("prefers the proxy's forwarded host and protocol (Vercel)", async () => {
    expect(
      await wordmarkOf({ host: "internal:3000", "x-forwarded-host": "whererat.com", "x-forwarded-proto": "https" }),
    ).toBe("https://whererat.com/brand/email/wordmark.svg");
  });
});

describe("/email-preview/newsletter with selected posts", () => {
  it("previews the chosen published post rather than the sample posts", async () => {
    h.newsItem = {
      id: "news-1",
      title: "Real published post",
      body: "Body text",
      type: "announcement",
      imageUrl: null,
      imageAlt: null,
      imagePositionX: 50,
      imagePositionY: 50,
      imageZoom: 1,
      authorId: "acct-admin",
      authorName: "Admin",
      authorAvatarUrl: "",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    };
    const { response } = await call(newsletter, "/email-preview/newsletter?id=news-1");
    const html = await response!.text();
    expect(html).toContain("Real published post");
    expect(html).toContain(`${ORIGIN}/news?post=news-1`);
    expect(html).not.toContain("Dark fur detected in Paddington");
  });
});
