/**
 * saveSightingImages (src/app/moderation/images/actions.ts). Collaborators are
 * mocked; `redirect` throws a tagged error carrying the URL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Movie, Sighting } from "@/lib/whererat";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    session: null as null | { id: string; name: string; role: "owner" | "moderator" },
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ MODERATOR_SESSION_COOKIE: "whererat_moderator" }));
vi.mock("@/lib/moderator-session", () => ({ verifyModeratorSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/moderation-store", () => ({ getAllMergedSightings: vi.fn() }));
vi.mock("@/lib/sighting-edit-store", () => ({ replaceSightingImages: vi.fn() }));
vi.mock("@/lib/media-storage", () => ({
  parseSightingImageGalleryForm: vi.fn(),
  SIGHTING_GALLERY_FIELD_NAMES: { file: "sightingImageFile", url: "sightingImageUrl" },
}));

import { saveSightingImages } from "@/app/moderation/images/actions";
import { revalidatePath } from "next/cache";
import { getAllMergedSightings } from "@/lib/moderation-store";
import { replaceSightingImages } from "@/lib/sighting-edit-store";
import { parseSightingImageGalleryForm } from "@/lib/media-storage";

const mockAll = vi.mocked(getAllMergedSightings);
const mockReplace = vi.mocked(replaceSightingImages);
const mockGallery = vi.mocked(parseSightingImageGalleryForm);
const mockRevalidate = vi.mocked(revalidatePath);

const RAT = { id: "rat", slug: "ratatouille-2007", title: "Ratatouille", metadata: {} } as unknown as Movie;
const SHOW = {
  id: "show",
  slug: "the-wire-2002",
  title: "The Wire",
  metadata: { syncSnapshot: { Type: "series" } },
} as unknown as Movie;

function sighting(id: string, over: Partial<Sighting> = {}): Sighting {
  return {
    id,
    movieId: "rat",
    timestamp: "42%",
    description: "d",
    prominence: "background",
    sceneType: "live-action",
    spoiler: false,
    confidence: "verified",
    verificationState: "verified",
    verifiedBy: "x",
    sourceIds: [],
    ...over,
  };
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function run(fields: Record<string, string>): Promise<string> {
  try {
    await saveSightingImages(form(fields));
  } catch (e) {
    if (e instanceof h.RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("expected a redirect");
}

const NEW_IMAGES = [{ url: "/uploads/sightings/new.jpg", alt: "new" }];

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { id: "acct-mod", name: "Mod", role: "moderator" };
  mockAll.mockResolvedValue([
    { sighting: sighting("queue-sub-1", { images: [{ url: "/uploads/sightings/old.jpg" }] }), movie: RAT },
    { sighting: sighting("queue-sub-2"), movie: RAT },
    { sighting: sighting("queue-sub-3"), movie: SHOW },
  ]);
  mockGallery.mockResolvedValue(NEW_IMAGES);
  mockReplace.mockResolvedValue(true);
});

describe("saveSightingImages", () => {
  it("sends a signed-out visitor to log in and writes nothing", async () => {
    h.session = null;
    expect(await run({ sightingId: "queue-sub-1" })).toBe("/login?next=/moderation/images");
    expect(mockAll).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("any moderator (not just the owner) can save; images replace the sighting's set", async () => {
    const url = await run({ sightingId: "queue-sub-2", filter: "without", q: "rat", page: "2" });
    expect(mockReplace).toHaveBeenCalledWith("queue-sub-2", NEW_IMAGES);
    expect(url).toBe("/moderation/images?filter=without&q=rat&page=2&toast=sighting-images-saved");
  });

  it("revalidates the movie page and both moderation pages", async () => {
    await run({ sightingId: "queue-sub-1" });
    expect(mockRevalidate.mock.calls.map(([p]) => p)).toEqual([
      "/movies/ratatouille-2007",
      "/moderation",
      "/moderation/images",
    ]);
    mockRevalidate.mockClear();
    await run({ sightingId: "queue-sub-3" });
    expect(mockRevalidate.mock.calls[0]![0]).toBe("/shows/the-wire-2002");
  });

  it("only keeps image URLs the sighting already has — anything else must be an upload", async () => {
    await run({ sightingId: "queue-sub-1" });
    const options = mockGallery.mock.calls[0]![2]!;
    expect(options.allowPersistedUrl!("/uploads/sightings/old.jpg")).toBe(true);
    expect(options.allowPersistedUrl!("https://evil.example/pixel.gif")).toBe(false);
    expect(options.allowPersistedUrl!("/uploads/sightings/someone-elses.jpg")).toBe(false);
  });

  it("'Save & next' opens the next sighting, keeping filter and search but not the page", async () => {
    const url = await run({
      sightingId: "queue-sub-1",
      nextSightingId: "queue-sub-2",
      intent: "next",
      filter: "without",
      q: "rat",
      page: "3",
    });
    expect(url).toBe("/moderation/images?filter=without&q=rat&edit=queue-sub-2&toast=sighting-images-saved");
  });

  it("'Save & next' with no next sighting just returns to the list", async () => {
    expect(await run({ sightingId: "queue-sub-1", intent: "next" })).toBe(
      "/moderation/images?toast=sighting-images-saved",
    );
  });

  it("an unknown or missing sighting id saves nothing and says so", async () => {
    for (const sightingId of ["queue-sub-gone", ""]) {
      expect(await run({ sightingId, filter: "with" })).toBe(
        "/moderation/images?filter=with&toast=sighting-images-missing",
      );
    }
    expect(mockGallery).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("reports a sighting that stopped being live between page load and save", async () => {
    mockReplace.mockResolvedValue(false);
    expect(await run({ sightingId: "queue-sub-1" })).toBe("/moderation/images?toast=sighting-images-missing");
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("rebuilds the return path from known parts, ignoring junk", async () => {
    const url = await run({ sightingId: "queue-sub-1", filter: "https://evil.example", page: "-1", q: "  " });
    expect(url).toBe("/moderation/images?toast=sighting-images-saved");
  });
});
