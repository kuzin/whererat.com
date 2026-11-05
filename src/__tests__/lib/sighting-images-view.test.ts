/**
 * List logic behind /moderation/images: filter by images, search, sort, paging,
 * the "Save & next" pointer, and the URLs the page and its action share.
 */
import { describe, it, expect } from "vitest";
import {
  SIGHTING_IMAGES_PAGE_SIZE,
  buildSightingImagesView,
  parseSightingImageFilter,
  parseSightingImagesPage,
  parseSightingImagesQuery,
  sightingImageCount,
  sightingImagesPath,
} from "@/lib/sighting-images-view";
import type { Movie, Sighting } from "@/lib/whererat";

function movie(id: string, title: string, releaseYear = 2000, imdb = "tt0000001"): Movie {
  return { id, slug: id, title, releaseYear, externalIds: { imdb }, metadata: {} } as unknown as Movie;
}

function sighting(id: string, over: Partial<Sighting> = {}): Sighting {
  return {
    id,
    movieId: "m",
    timestamp: "50%",
    title: `Sighting ${id}`,
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

const img = (url: string) => ({ url });

describe("parsers", () => {
  it("only knows the three filters, defaulting to all", () => {
    expect(parseSightingImageFilter("without")).toBe("without");
    expect(parseSightingImageFilter("with")).toBe("with");
    for (const raw of ["all", "", "WITH", null, undefined, ["with"], "missing"]) {
      expect(parseSightingImageFilter(raw)).toBe("all");
    }
  });

  it("pages are positive integers, anything else means 'not given'", () => {
    expect(parseSightingImagesPage("3")).toBe(3);
    expect(parseSightingImagesPage(" 2 ")).toBe(2);
    for (const raw of ["0", "-1", "1.5", "abc", "", "9999999", null, undefined]) {
      expect(parseSightingImagesPage(raw)).toBeUndefined();
    }
  });

  it("trims and caps the search query", () => {
    expect(parseSightingImagesQuery("  rat  ")).toBe("rat");
    expect(parseSightingImagesQuery("x".repeat(500))).toHaveLength(200);
    expect(parseSightingImagesQuery(null)).toBe("");
  });
});

describe("sightingImagesPath", () => {
  it("is the bare path for the default state", () => {
    expect(sightingImagesPath({})).toBe("/moderation/images");
    expect(sightingImagesPath({ filter: "all", q: "", page: 1 })).toBe("/moderation/images");
  });

  it("encodes every part, dropping defaults", () => {
    expect(
      sightingImagesPath({ filter: "without", q: "a&b=c", page: 2, edit: "queue-sub 1", toast: "sighting-images-saved" }),
    ).toBe("/moderation/images?filter=without&q=a%26b%3Dc&page=2&edit=queue-sub+1&toast=sighting-images-saved");
  });

  it("always stays on the moderation images page", () => {
    const path = sightingImagesPath({ q: "//evil.example", edit: "https://evil.example" });
    expect(path.startsWith("/moderation/images?")).toBe(true);
    expect(new URL(path, "https://whererat.com").origin).toBe("https://whererat.com");
  });
});

describe("sightingImageCount", () => {
  it("counts real images, ignoring placeholders and duplicate legacy imageUrl", () => {
    expect(sightingImageCount(sighting("a"))).toBe(0);
    expect(sightingImageCount(sighting("a", { images: [img("/a.png"), img("/b.png")], imageUrl: "/a.png" }))).toBe(2);
    expect(sightingImageCount(sighting("a", { imageUrl: "https://placehold.co/1x1" }))).toBe(0);
    expect(sightingImageCount(sighting("a", { imageUrl: "/legacy.png" }))).toBe(1);
  });
});

describe("buildSightingImagesView", () => {
  const jaws = movie("jaws", "Jaws", 1975, "tt0073195");
  const alien = movie("alien", "alien", 1979, "tt0078748");
  const rat = movie("rat", "Ratatouille", 2007, "tt0382932");
  const entries = [
    { movie: jaws, sighting: sighting("j2", { timestamp: "80%", images: [img("/j2.png")] }) },
    { movie: rat, sighting: sighting("r1", { title: "Remy cooks", timestamp: "10%" }) },
    { movie: jaws, sighting: sighting("j1", { timestamp: "20%" }) },
    { movie: alien, sighting: sighting("a1", { episodeTitle: "Pilot", images: [img("/a1.png")] }) },
  ];
  const ids = (items: Array<{ sighting: Sighting }>) => items.map((e) => e.sighting.id);

  it("sorts by movie title (case-insensitive) then running order", () => {
    const view = buildSightingImagesView(entries, { filter: "all", q: "" });
    expect(ids(view.pageItems)).toEqual(["a1", "j1", "j2", "r1"]);
    expect(view.counts).toEqual({ all: 4, without: 2, with: 2 });
  });

  it("filters to sightings without / with images", () => {
    expect(ids(buildSightingImagesView(entries, { filter: "without", q: "" }).pageItems)).toEqual(["j1", "r1"]);
    expect(ids(buildSightingImagesView(entries, { filter: "with", q: "" }).pageItems)).toEqual(["a1", "j2"]);
  });

  it("searches movie title, sighting title, episode title and IMDb id; counts follow the search", () => {
    expect(ids(buildSightingImagesView(entries, { filter: "all", q: "JAWS" }).pageItems)).toEqual(["j1", "j2"]);
    expect(ids(buildSightingImagesView(entries, { filter: "all", q: "remy" }).pageItems)).toEqual(["r1"]);
    expect(ids(buildSightingImagesView(entries, { filter: "all", q: "pilot" }).pageItems)).toEqual(["a1"]);
    expect(ids(buildSightingImagesView(entries, { filter: "all", q: "tt0382932" }).pageItems)).toEqual(["r1"]);
    expect(buildSightingImagesView(entries, { filter: "without", q: "jaws" }).counts).toEqual({ all: 2, without: 1, with: 1 });
  });

  it("points 'next' at the following sighting in the filtered list", () => {
    const view = buildSightingImagesView(entries, { filter: "without", q: "", edit: "j1" });
    expect(view.editing?.sighting.id).toBe("j1");
    expect(view.editPosition).toBe(1);
    expect(view.nextSightingId).toBe("r1");
    expect(buildSightingImagesView(entries, { filter: "without", q: "", edit: "r1" }).nextSightingId).toBeUndefined();
  });

  it("still opens a sighting outside the current filter, without a next pointer", () => {
    const view = buildSightingImagesView(entries, { filter: "without", q: "", edit: "j2" });
    expect(view.editing?.sighting.id).toBe("j2");
    expect(view.editPosition).toBeUndefined();
    expect(view.nextSightingId).toBeUndefined();
  });

  it("does not open unknown ids", () => {
    expect(buildSightingImagesView(entries, { filter: "all", q: "", edit: "nope" }).editing).toBeUndefined();
  });

  describe("paging", () => {
    const many = Array.from({ length: SIGHTING_IMAGES_PAGE_SIZE * 2 + 3 }, (_, i) => ({
      movie: jaws,
      sighting: sighting(`s${String(i).padStart(3, "0")}`, { timestamp: `${i % 100}%` }),
    }));

    it("pages through the filtered list and clamps out-of-range pages", () => {
      const first = buildSightingImagesView(many, { filter: "all", q: "" });
      expect(first.pageCount).toBe(3);
      expect(first.pageItems).toHaveLength(SIGHTING_IMAGES_PAGE_SIZE);
      const last = buildSightingImagesView(many, { filter: "all", q: "", page: 99 });
      expect(last.page).toBe(3);
      expect(last.pageItems).toHaveLength(3);
      expect(last.start).toBe(SIGHTING_IMAGES_PAGE_SIZE * 2);
    });

    it("without an explicit page, shows the page holding the sighting being edited", () => {
      const target = many[SIGHTING_IMAGES_PAGE_SIZE + 1]!.sighting.id;
      const view = buildSightingImagesView(many, { filter: "all", q: "", edit: target });
      expect(view.page).toBe(2);
      expect(view.pageItems.some((e) => e.sighting.id === target)).toBe(true);
      // An explicit page wins.
      expect(buildSightingImagesView(many, { filter: "all", q: "", page: 1, edit: target }).page).toBe(1);
    });

    it("an empty list is one empty page", () => {
      const view = buildSightingImagesView([], { filter: "all", q: "" });
      expect(view).toMatchObject({ total: 0, page: 1, pageCount: 1, pageItems: [] });
    });
  });
});
