/**
 * Server actions behind /moderation/news. Owner-only; everything else mocked.
 * `redirect` throws a tagged error (like Next does) so we can assert where each
 * path ends up.
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
    session: undefined as
      | undefined
      | {
          id: string;
          name: string;
          username: string;
          email: string;
          avatarUrl: string;
          role: "owner" | "moderator";
        },
    cookieValue: "signed-cookie" as string | undefined,
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (h.cookieValue === undefined ? undefined : { name, value: h.cookieValue }),
  })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ MODERATOR_SESSION_COOKIE: "whererat_moderator" }));
vi.mock("@/lib/moderator-session", () => ({
  verifyModeratorSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/news-store", () => ({
  NEWS_ITEM_TYPES: [
    { value: "announcement", label: "Announcement" },
    { value: "product-news", label: "Product news" },
    { value: "community", label: "Community" },
    { value: "update", label: "Update" },
  ],
  createNewsItem: vi.fn(),
  updateNewsItem: vi.fn(),
  toggleNewsItemPublished: vi.fn(),
  deleteNewsItem: vi.fn(),
  getNewsItemById: vi.fn(),
}));
vi.mock("@/lib/media-storage", () => ({ persistImageFile: vi.fn() }));
vi.mock("@/lib/news-notify", () => ({
  defaultDigestSubject: vi.fn(() => "default subject"),
  sendDigestNewsletterToSubscribers: vi.fn(),
  sendDigestNewsletterTest: vi.fn(),
}));

import {
  createNewsItemAction,
  updateNewsItemAction,
  togglePublishAction,
  sendNewsletterDigestAction,
  sendNewsletterDigestTestAction,
  deleteNewsItemAction,
} from "@/app/moderation/news/actions";
import { revalidatePath } from "next/cache";
import { verifyModeratorSession } from "@/lib/moderator-session";
import {
  createNewsItem,
  updateNewsItem,
  toggleNewsItemPublished,
  deleteNewsItem,
  getNewsItemById,
} from "@/lib/news-store";
import { persistImageFile } from "@/lib/media-storage";
import {
  sendDigestNewsletterToSubscribers,
  sendDigestNewsletterTest,
  defaultDigestSubject,
} from "@/lib/news-notify";

const OWNER = {
  id: "acc-owner",
  name: "Olive Owner",
  username: "olive",
  email: "olive@example.com",
  avatarUrl: "/a.png",
  role: "owner" as const,
};
const MOD = { ...OWNER, id: "acc-mod", name: "Mo", role: "moderator" as const };

function form(fields: Record<string, string | string[] | File>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.append(k, v);
  }
  return fd;
}

async function redirectOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof h.RedirectSignal) return e.url;
    throw e;
  }
}

const publishedItem = (id: string) =>
  ({ id, title: `T${id}`, body: "b", publishedAt: new Date("2026-01-01") }) as never;

const mutating = [createNewsItem, updateNewsItem, toggleNewsItemPublished, deleteNewsItem];

beforeEach(() => {
  vi.clearAllMocks();
  h.session = OWNER;
  h.cookieValue = "signed-cookie";
  vi.mocked(createNewsItem).mockResolvedValue({ id: "news-1" } as never);
  vi.mocked(persistImageFile).mockResolvedValue("/uploads/x.png");
});

describe("owner-only guard", () => {
  const cases: [string, (fd: FormData) => Promise<unknown>, FormData][] = [
    ["createNewsItemAction", createNewsItemAction, form({ title: "T", body: "B" })],
    ["updateNewsItemAction", updateNewsItemAction, form({ id: "n1", title: "T", body: "B" })],
    ["togglePublishAction", togglePublishAction, form({ id: "n1", publish: "true" })],
    ["sendNewsletterDigestAction", sendNewsletterDigestAction, form({ newsItemId: "n1" })],
    ["sendNewsletterDigestTestAction", sendNewsletterDigestTestAction, form({ newsItemId: "n1" })],
    ["deleteNewsItemAction", deleteNewsItemAction, form({ id: "n1" })],
  ];

  it.each(cases)("%s redirects an anonymous visitor and does nothing", async (_n, action, fd) => {
    h.session = undefined;
    expect(await redirectOf(action(fd))).toBe("/moderation");
    for (const m of mutating) expect(m).not.toHaveBeenCalled();
    expect(sendDigestNewsletterToSubscribers).not.toHaveBeenCalled();
    expect(sendDigestNewsletterTest).not.toHaveBeenCalled();
    expect(persistImageFile).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(cases)("%s redirects a plain moderator and does nothing", async (_n, action, fd) => {
    h.session = MOD;
    expect(await redirectOf(action(fd))).toBe("/moderation");
    for (const m of mutating) expect(m).not.toHaveBeenCalled();
    expect(sendDigestNewsletterToSubscribers).not.toHaveBeenCalled();
    expect(sendDigestNewsletterTest).not.toHaveBeenCalled();
  });

  it("reads the moderator cookie and verifies it against the live account", async () => {
    h.cookieValue = "cookie-abc";
    await redirectOf(deleteNewsItemAction(form({ id: "n1" })));
    expect(verifyModeratorSession).toHaveBeenCalledWith("cookie-abc");
  });

  it("passes undefined to the verifier when there is no cookie", async () => {
    h.cookieValue = undefined;
    h.session = undefined;
    expect(await redirectOf(deleteNewsItemAction(form({ id: "n1" })))).toBe("/moderation");
    expect(verifyModeratorSession).toHaveBeenCalledWith(undefined);
  });
});

describe("createNewsItemAction", () => {
  it("creates an item attributed to the session owner and redirects with a toast", async () => {
    const url = await redirectOf(
      createNewsItemAction(
        form({ title: "  Hello  ", body: "  World ", type: "community", image_alt: " alt ", publish: "true" }),
      ),
    );
    expect(url).toBe("/moderation/news?toast=news-created");
    expect(createNewsItem).toHaveBeenCalledWith({
      title: "Hello",
      body: "World",
      type: "community",
      imageUrl: null,
      imageAlt: "alt",
      imagePositionX: 50,
      imagePositionY: 50,
      imageZoom: 1,
      authorId: "acc-owner",
      authorName: "Olive Owner",
      authorAvatarUrl: "/a.png",
      publish: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/news");
    expect(revalidatePath).toHaveBeenCalledWith("/moderation/news");
  });

  it("defaults to an unpublished announcement", async () => {
    await redirectOf(createNewsItemAction(form({ title: "T", body: "B" })));
    expect(createNewsItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: "announcement", publish: false, imageAlt: null }),
    );
  });

  it("only publishes on the exact string 'true'", async () => {
    for (const v of ["1", "on", "TRUE", "yes"]) {
      vi.mocked(createNewsItem).mockClear();
      await redirectOf(createNewsItemAction(form({ title: "T", body: "B", publish: v })));
      expect(createNewsItem).toHaveBeenCalledWith(expect.objectContaining({ publish: false }));
    }
  });

  it.each([
    [{ title: "", body: "B" }],
    [{ title: "T", body: "" }],
    [{ title: "   ", body: "B" }],
    [{ title: "T", body: " \n\t " }],
    [{}],
  ])("silently ignores missing title/body %j", async (fields) => {
    const url = await redirectOf(createNewsItemAction(form(fields as Record<string, string>)));
    expect(url).toBeUndefined();
    expect(createNewsItem).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("parses position/zoom, falling back to defaults on junk and never going below 1x zoom", async () => {
    await redirectOf(
      createNewsItemAction(
        form({ title: "T", body: "B", imagePositionX: "12.5", imagePositionY: "abc", imageZoom: "0.2" }),
      ),
    );
    expect(createNewsItem).toHaveBeenCalledWith(
      expect.objectContaining({ imagePositionX: 12.5, imagePositionY: 50, imageZoom: 1 }),
    );
  });

  it("persists an uploaded image into the sightings folder with an 8MB cap", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await redirectOf(createNewsItemAction(form({ title: "T", body: "B", newsImage: file })));
    expect(persistImageFile).toHaveBeenCalledWith(expect.any(File), {
      folder: "sightings",
      maxBytes: 8 * 1024 * 1024,
    });
    expect(createNewsItem).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "/uploads/x.png" }));
  });

  it("skips empty file inputs (browsers send a 0-byte file when nothing is chosen)", async () => {
    const empty = new File([], "", { type: "application/octet-stream" });
    await redirectOf(createNewsItemAction(form({ title: "T", body: "B", newsImage: empty })));
    expect(persistImageFile).not.toHaveBeenCalled();
    expect(createNewsItem).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: null }));
  });

  it("falls back to no image when the upload is rejected (bad type / too big)", async () => {
    vi.mocked(persistImageFile).mockResolvedValue(undefined);
    const file = new File([new Uint8Array([1])], "a.exe", { type: "application/x-msdownload" });
    await redirectOf(createNewsItemAction(form({ title: "T", body: "B", newsImage: file })));
    expect(createNewsItem).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: null }));
  });

  it("ignores a non-File 'newsImage' string value", async () => {
    await redirectOf(createNewsItemAction(form({ title: "T", body: "B", newsImage: "/etc/passwd" })));
    expect(persistImageFile).not.toHaveBeenCalled();
  });

  it("propagates store failures instead of redirecting as if it succeeded", async () => {
    vi.mocked(createNewsItem).mockRejectedValue(new Error("db down"));
    await expect(createNewsItemAction(form({ title: "T", body: "B" }))).rejects.toThrow("db down");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("BUG: an unknown 'type' is passed through to the DB (CHECK violation → 500) instead of being validated", async () => {
    await redirectOf(createNewsItemAction(form({ title: "T", body: "B", type: "<script>" })));
    const arg = vi.mocked(createNewsItem).mock.calls[0]?.[0];
    expect(["announcement", "product-news", "community", "update"]).toContain(arg?.type);
  });

  it("BUG: image position/zoom are not clamped (gallery uploads clamp 0-100 / 1-4); Infinity or 9999 is stored", async () => {
    await redirectOf(
      createNewsItemAction(
        form({ title: "T", body: "B", imagePositionX: "-500", imagePositionY: "99999", imageZoom: "Infinity" }),
      ),
    );
    const arg = vi.mocked(createNewsItem).mock.calls[0]![0];
    expect(arg.imagePositionX).toBeGreaterThanOrEqual(0);
    expect(arg.imagePositionY).toBeLessThanOrEqual(100);
    expect(Number.isFinite(arg.imageZoom)).toBe(true);
    expect(arg.imageZoom).toBeLessThanOrEqual(4);
  });

  it("BUG: the image is written to storage before title/body are validated, orphaning a file when the form is rejected", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    await redirectOf(createNewsItemAction(form({ title: "", body: "", newsImage: file })));
    expect(persistImageFile).not.toHaveBeenCalled();
  });
});

describe("updateNewsItemAction", () => {
  it("updates the item and redirects with a toast", async () => {
    const url = await redirectOf(
      updateNewsItemAction(
        form({ id: " n1 ", title: " T ", body: " B ", type: "update", currentImageUrl: "/old.png", image_alt: "x" }),
      ),
    );
    expect(url).toBe("/moderation/news?toast=news-updated");
    expect(updateNewsItem).toHaveBeenCalledWith("n1", {
      title: "T",
      body: "B",
      type: "update",
      imageUrl: "/old.png",
      imageAlt: "x",
      imagePositionX: 50,
      imagePositionY: 50,
      imageZoom: 1,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/news");
  });

  it("a new upload replaces the current image", async () => {
    const file = new File([new Uint8Array([1])], "n.png", { type: "image/png" });
    await redirectOf(
      updateNewsItemAction(form({ id: "n1", title: "T", body: "B", currentImageUrl: "/old.png", newsImage: file })),
    );
    expect(updateNewsItem).toHaveBeenCalledWith("n1", expect.objectContaining({ imageUrl: "/uploads/x.png" }));
  });

  it("keeps the current image if the new upload is rejected", async () => {
    vi.mocked(persistImageFile).mockResolvedValue(undefined);
    const file = new File([new Uint8Array([1])], "n.png", { type: "image/png" });
    await redirectOf(
      updateNewsItemAction(form({ id: "n1", title: "T", body: "B", currentImageUrl: "/old.png", newsImage: file })),
    );
    expect(updateNewsItem).toHaveBeenCalledWith("n1", expect.objectContaining({ imageUrl: "/old.png" }));
  });

  it("clears the image when there is neither an upload nor a current URL", async () => {
    await redirectOf(updateNewsItemAction(form({ id: "n1", title: "T", body: "B" })));
    expect(updateNewsItem).toHaveBeenCalledWith("n1", expect.objectContaining({ imageUrl: null }));
  });

  it.each([
    [{ title: "T", body: "B" }],
    [{ id: "  ", title: "T", body: "B" }],
    [{ id: "n1", title: "", body: "B" }],
    [{ id: "n1", title: "T", body: "" }],
  ])("does nothing when id/title/body is missing %j", async (fields) => {
    expect(await redirectOf(updateNewsItemAction(form(fields as Record<string, string>)))).toBeUndefined();
    expect(updateNewsItem).not.toHaveBeenCalled();
  });

  it("BUG: an unknown 'type' is passed through to the DB instead of being validated", async () => {
    await redirectOf(updateNewsItemAction(form({ id: "n1", title: "T", body: "B", type: "bogus" })));
    const arg = vi.mocked(updateNewsItem).mock.calls[0]?.[1];
    expect(["announcement", "product-news", "community", "update"]).toContain(arg?.type);
  });
});

describe("togglePublishAction", () => {
  it("publishes and redirects with news-published", async () => {
    const url = await redirectOf(togglePublishAction(form({ id: "n1", publish: "true" })));
    expect(url).toBe("/moderation/news?toast=news-published");
    expect(toggleNewsItemPublished).toHaveBeenCalledWith("n1", true);
  });

  it("unpublishes for anything other than 'true'", async () => {
    const url = await redirectOf(togglePublishAction(form({ id: "n1", publish: "false" })));
    expect(url).toBe("/moderation/news?toast=news-unpublished");
    expect(toggleNewsItemPublished).toHaveBeenCalledWith("n1", false);
  });

  it("does nothing without an id", async () => {
    expect(await redirectOf(togglePublishAction(form({ publish: "true" })))).toBeUndefined();
    expect(toggleNewsItemPublished).not.toHaveBeenCalled();
  });
});

describe("deleteNewsItemAction", () => {
  it("deletes and redirects", async () => {
    const url = await redirectOf(deleteNewsItemAction(form({ id: " n1 " })));
    expect(url).toBe("/moderation/news?toast=news-deleted");
    expect(deleteNewsItem).toHaveBeenCalledWith("n1");
    expect(revalidatePath).toHaveBeenCalledWith("/news");
  });

  it("does nothing without an id", async () => {
    expect(await redirectOf(deleteNewsItemAction(form({ id: "   " })))).toBeUndefined();
    expect(deleteNewsItem).not.toHaveBeenCalled();
  });
});

describe("sendNewsletterDigestAction", () => {
  beforeEach(() => {
    vi.mocked(getNewsItemById).mockImplementation(async (id: string) => publishedItem(id));
    vi.mocked(sendDigestNewsletterToSubscribers).mockResolvedValue({ recipientCount: 7 } as never);
  });

  it("redirects with newsletter-empty (and sends nothing) when no items are selected", async () => {
    const url = await redirectOf(sendNewsletterDigestAction(form({})));
    expect(url).toBe("/moderation/news?toast=newsletter-empty");
    expect(sendDigestNewsletterToSubscribers).not.toHaveBeenCalled();
    expect(getNewsItemById).not.toHaveBeenCalled();
  });

  it("ignores blank ids", async () => {
    const url = await redirectOf(sendNewsletterDigestAction(form({ newsItemId: ["", "  "] })));
    expect(url).toBe("/moderation/news?toast=newsletter-empty");
  });

  it("never sends unpublished (draft) items to subscribers", async () => {
    vi.mocked(getNewsItemById).mockImplementation(
      async (id: string) => ({ id, title: "draft", publishedAt: null }) as never,
    );
    const url = await redirectOf(sendNewsletterDigestAction(form({ newsItemId: "d1" })));
    expect(url).toBe("/moderation/news?toast=newsletter-empty");
    expect(sendDigestNewsletterToSubscribers).not.toHaveBeenCalled();
  });

  it("drops unknown ids but still sends the valid ones", async () => {
    vi.mocked(getNewsItemById).mockImplementation(async (id: string) =>
      id === "ghost" ? undefined : publishedItem(id),
    );
    await redirectOf(sendNewsletterDigestAction(form({ newsItemId: ["a", "ghost", "b"] })));
    const items = vi.mocked(sendDigestNewsletterToSubscribers).mock.calls[0]![0] as { id: string }[];
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("sends with the default subject when none is given, attributed to the session", async () => {
    const url = await redirectOf(sendNewsletterDigestAction(form({ newsItemId: ["a", "b"] })));
    expect(url).toBe("/moderation/news?toast=newsletter-sent&count=7");
    expect(defaultDigestSubject).toHaveBeenCalled();
    expect(sendDigestNewsletterToSubscribers).toHaveBeenCalledWith(
      expect.any(Array),
      { id: "acc-owner", name: "Olive Owner" },
      "default subject",
      undefined,
      undefined,
    );
    expect(revalidatePath).toHaveBeenCalledWith("/moderation/news");
  });

  it("uses trimmed custom subject, heading and subhead", async () => {
    await redirectOf(
      sendNewsletterDigestAction(
        form({ newsItemId: "a", subject: "  Big news ", heading: " H ", subhead: " S " }),
      ),
    );
    expect(sendDigestNewsletterToSubscribers).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      "Big news",
      "H",
      "S",
    );
  });

  it("treats blank heading/subhead as absent", async () => {
    await redirectOf(sendNewsletterDigestAction(form({ newsItemId: "a", heading: "  ", subhead: "" })));
    const args = vi.mocked(sendDigestNewsletterToSubscribers).mock.calls[0]!;
    expect(args[3]).toBeUndefined();
    expect(args[4]).toBeUndefined();
  });

  it("reports no-subscribers when nobody received it", async () => {
    vi.mocked(sendDigestNewsletterToSubscribers).mockResolvedValue({ recipientCount: 0 } as never);
    const url = await redirectOf(sendNewsletterDigestAction(form({ newsItemId: "a" })));
    expect(url).toBe("/moderation/news?toast=newsletter-no-subscribers");
  });

  it("propagates send failures rather than reporting success", async () => {
    vi.mocked(sendDigestNewsletterToSubscribers).mockRejectedValue(new Error("smtp"));
    await expect(sendNewsletterDigestAction(form({ newsItemId: "a" }))).rejects.toThrow("smtp");
  });
});

describe("sendNewsletterDigestTestAction", () => {
  beforeEach(() => {
    vi.mocked(getNewsItemById).mockImplementation(async (id: string) => publishedItem(id));
  });

  it("sends only to the signed-in owner's own address", async () => {
    const url = await redirectOf(
      sendNewsletterDigestTestAction(form({ newsItemId: "a", subject: " S ", heading: "H" })),
    );
    expect(url).toBe("/moderation/news?toast=newsletter-test-sent&compose=1");
    expect(sendDigestNewsletterTest).toHaveBeenCalledWith(
      expect.any(Array),
      "olive@example.com",
      "S",
      "H",
      undefined,
    );
    expect(sendDigestNewsletterToSubscribers).not.toHaveBeenCalled();
  });

  it("cannot be pointed at another recipient through the form", async () => {
    await redirectOf(
      sendNewsletterDigestTestAction(form({ newsItemId: "a", to: "victim@example.com", email: "victim@example.com" })),
    );
    expect(vi.mocked(sendDigestNewsletterTest).mock.calls[0]![1]).toBe("olive@example.com");
  });

  it("redirects newsletter-empty for no/unpublished items", async () => {
    expect(await redirectOf(sendNewsletterDigestTestAction(form({})))).toBe(
      "/moderation/news?toast=newsletter-empty",
    );
    expect(sendDigestNewsletterTest).not.toHaveBeenCalled();
  });
});
