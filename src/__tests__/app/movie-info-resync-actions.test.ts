/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed captured override payloads */
/**
 * updateMovieInfo and resyncMovieFromImdb from src/app/movies/[slug]/actions.ts.
 * (updateSightingInfo / deleteSighting / deleteMovie are in movie-sighting-actions.test.ts.)
 * Every collaborator is mocked; `redirect` throws a tagged error carrying the URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    session: null as null | { id: string; name: string; username: string; email: string; role: "owner" | "moderator" },
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
vi.mock("@/lib/movie-edit-store", () => ({
  clearMovieOverride: vi.fn(),
  deleteMovieById: vi.fn(),
  updateMovieOverride: vi.fn(),
}));
vi.mock("@/lib/movie-imdb-sync", () => ({
  fetchImdbMedia: vi.fn(async () => ({ videos: [], images: [] })),
  fetchImdbRelated: vi.fn(async () => []),
}));
vi.mock("@/lib/moderation-store", () => ({ reviewSubmission: vi.fn() }));
vi.mock("@/lib/sighting-edit-store", () => ({ deleteSightingById: vi.fn(), updateSightingOverride: vi.fn() }));
vi.mock("@/lib/movie-catalog", () => ({
  getCatalogMovieByImdbId: vi.fn(),
  getCatalogMovieBySlug: vi.fn(),
}));
vi.mock("@/lib/media-storage", () => ({
  persistSightingFiles: vi.fn().mockResolvedValue([]),
  parseSightingImageGalleryForm: vi.fn().mockResolvedValue([]),
  SIGHTING_GALLERY_FIELD_NAMES: {},
  SIGHTING_GALLERY_SENTINEL: "sightingImageListManaged",
}));
vi.mock("@/lib/movie-page-visuals", () => ({ getSyncedMoviePageVisuals: vi.fn() }));
vi.mock("@/lib/tmdb-banner", () => ({ getTmdbBackdropUrl: vi.fn() }));

import { updateMovieInfo, resyncMovieFromImdb } from "@/app/movies/[slug]/actions";
import { revalidatePath } from "next/cache";
import { clearMovieOverride, updateMovieOverride } from "@/lib/movie-edit-store";
import { fetchImdbMedia, fetchImdbRelated } from "@/lib/movie-imdb-sync";
import { getCatalogMovieBySlug } from "@/lib/movie-catalog";
import { getSyncedMoviePageVisuals } from "@/lib/movie-page-visuals";
import { getTmdbBackdropUrl } from "@/lib/tmdb-banner";

const mockBySlug = vi.mocked(getCatalogMovieBySlug);
const mockUpdate = vi.mocked(updateMovieOverride);
const mockClear = vi.mocked(clearMovieOverride);
const mockRevalidate = vi.mocked(revalidatePath);
const mockVisuals = vi.mocked(getSyncedMoviePageVisuals);
const mockBackdrop = vi.mocked(getTmdbBackdropUrl);
const mockRelated = vi.mocked(fetchImdbRelated);
const mockMedia = vi.mocked(fetchImdbMedia);

const MOD = { id: "mod-1", name: "Mo", username: "mo", email: "mo@x.io", role: "moderator" as const };

function baseMovie(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    slug: "ratatouille",
    title: "Ratatouille",
    releaseYear: 2007,
    runtimeMinutes: 111,
    summary: "orig summary",
    posterUrl: "https://img/p.jpg",
    genres: ["Animation"],
    externalIds: { imdb: "tt0382932", tmdb: undefined },
    metadata: {
      tagline: "old tag",
      rating: "G",
      productionCountries: ["US"],
      syncSnapshot: { Type: "movie" },
      ...meta,
    },
    ...over,
  } as never;
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function run(fn: (fd: FormData) => Promise<unknown>, fd: FormData) {
  try {
    await fn(fd);
    return { redirect: undefined as string | undefined };
  } catch (e) {
    if (e instanceof h.RedirectSignal) return { redirect: e.url };
    throw e;
  }
}

const override = () => mockUpdate.mock.calls.at(-1)![1] as Record<string, any> & { metadata: Record<string, any> };

const savedEnv: Record<string, string | undefined> = {};
const ENV = ["OMDB_API_KEY", "TMDB_READ_ACCESS_TOKEN", "TMDB_API_READ_ACCESS_TOKEN", "TMDB_BEARER_TOKEN"];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.session = MOD;
  mockBySlug.mockResolvedValue(baseMovie());
  mockUpdate.mockResolvedValue(undefined);
  mockVisuals.mockResolvedValue({
    bannerUrl: "https://banner/b.jpg",
    bannerIsWidescreen: true,
    palette: { wash: "#fff9eb", columnWash: "#fffdf6", accent: "#ea580c", heroBloom: "#2b1a10" },
    paletteDark: { wash: "#111111", columnWash: "#0c0c0c", accent: "#d69e2e", heroBloom: "#080808" },
  });
  mockBackdrop.mockResolvedValue(null);
  mockRelated.mockResolvedValue([]);
  mockMedia.mockResolvedValue({ videos: [], images: [] });
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("updateMovieInfo", () => {
  it("requires a moderator session and writes nothing without one", async () => {
    h.session = null;
    expect((await run(updateMovieInfo, form({ slug: "ratatouille", title: "x" }))).redirect).toBe("/login");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockBySlug).not.toHaveBeenCalled();
  });

  it("an unknown slug bounces to the catalog without writing", async () => {
    mockBySlug.mockResolvedValue(undefined);
    expect((await run(updateMovieInfo, form({ slug: "nope" }))).redirect).toBe("/#catalog");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("a blank slug is looked up as empty and rejected", async () => {
    mockBySlug.mockResolvedValue(undefined);
    await run(updateMovieInfo, form({ slug: "  " }));
    expect(mockBySlug).toHaveBeenCalledWith("");
  });

  it("writes trimmed fields, parses lists, and redirects with a toast", async () => {
    const r = await run(
      updateMovieInfo,
      form({
        slug: "ratatouille",
        title: "  New Title ",
        releaseYear: "2008",
        runtimeMinutes: "120",
        summary: " New summary ",
        posterUrl: " https://img/new.jpg ",
        genres: " Horror , ,Comedy ",
        countries: "France, ,Italy",
        tagline: " tag ",
        rating: " PG ",
        director: " D ",
        writers: "W",
        cast: "C",
        imdbRating: "8.1",
        imdbVotes: "1,000",
        metascore: "90",
        awards: "A",
        originalLanguage: "fr",
      }),
    );
    expect(r.redirect).toBe("/movies/ratatouille?toast=movie-saved");
    expect(mockUpdate).toHaveBeenCalledWith("m-1", expect.any(Object));
    const o = override();
    expect(o).toMatchObject({
      title: "New Title",
      releaseYear: 2008,
      runtimeMinutes: 120,
      summary: "New summary",
      posterUrl: "https://img/new.jpg",
      genres: ["Horror", "Comedy"],
    });
    expect(o.metadata).toMatchObject({
      tagline: "tag",
      rating: "PG",
      director: "D",
      writers: "W",
      cast: "C",
      imdbRating: "8.1",
      imdbVotes: "1,000",
      metascore: "90",
      awards: "A",
      originalLanguage: "fr",
      productionCountries: ["France", "Italy"],
      syncSnapshot: { Type: "movie" },
    });
    expect(mockRevalidate).toHaveBeenCalledWith("/movies/ratatouille");
    expect(mockRevalidate).toHaveBeenCalledWith("/shows/ratatouille");
    expect(mockRevalidate).toHaveBeenCalledWith("/moderation");
  });

  it("blank title / summary / poster / genres / countries keep the current values", async () => {
    await run(
      updateMovieInfo,
      form({ slug: "ratatouille", title: "  ", summary: "", posterUrl: "", genres: "", countries: "" }),
    );
    const o = override();
    expect(o).toMatchObject({
      title: "Ratatouille",
      summary: "orig summary",
      posterUrl: "https://img/p.jpg",
      genres: ["Animation"],
    });
    expect(o.metadata.productionCountries).toEqual(["US"]);
  });

  it("series are redirected to /shows/<slug>", async () => {
    mockBySlug.mockResolvedValue(baseMovie({}, { syncSnapshot: { Type: "series" } }));
    expect((await run(updateMovieInfo, form({ slug: "ratatouille" }))).redirect).toBe(
      "/shows/ratatouille?toast=movie-saved",
    );
  });

  describe("accent colour", () => {
    it.each([
      ["#ABCDEF", "#abcdef"],
      ["abcdef", "#abcdef"],
      ["  #00FF7f ", "#00ff7f"],
    ])("normalises %j -> %s", async (input, expected) => {
      await run(updateMovieInfo, form({ slug: "ratatouille", overrideAccent: input }));
      expect(override().metadata.overrideAccent).toBe(expected);
    });

    it.each([[""], ["   "], ["#fff"], ["red"], ["#12345g"], ["#1234567"], ["url(javascript:alert(1))"], ["#abcdef; background:url(x)"]])(
      "clears (null) for %j so the JSONB merge overwrites a stored accent",
      async (input) => {
        await run(updateMovieInfo, form({ slug: "ratatouille", overrideAccent: input }));
        expect(override().metadata.overrideAccent).toBeNull();
      },
    );
  });

  it("does not let hostile text escape into anything but values", async () => {
    await run(updateMovieInfo, form({ slug: "ratatouille", title: "'; drop table movies;--" }));
    expect(override().title).toBe("'; drop table movies;--");
  });

  it("propagates a store failure without redirecting to success", async () => {
    mockUpdate.mockRejectedValue(new Error("db down"));
    await expect(run(updateMovieInfo, form({ slug: "ratatouille" }))).rejects.toThrow("db down");
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it.fails("BUG: a blank / non-numeric release year or runtime is written as 0 / NaN (no parseReleaseYear-style validation)", async () => {
    await run(updateMovieInfo, form({ slug: "ratatouille", releaseYear: "", runtimeMinutes: "abc" }));
    const o = override();
    expect(o.releaseYear).toBe(2007);
    expect(o.runtimeMinutes).toBe(111);
  });

  it.fails("BUG: out-of-range / fractional years and runtimes are forwarded to Postgres (int4) instead of rejected", async () => {
    await run(updateMovieInfo, form({ slug: "ratatouille", releaseYear: "99999999999", runtimeMinutes: "-5.5" }));
    const o = override();
    expect(Number.isInteger(o.releaseYear) && o.releaseYear >= 1800 && o.releaseYear <= 2200).toBe(true);
    expect(Number.isInteger(o.runtimeMinutes) && o.runtimeMinutes > 0).toBe(true);
  });

  it.fails("BUG: manual pagePalette / pagePaletteDark are 'cleared' with undefined, which JSON drops, so the stored values survive the `metadata || $11` merge (file's own comment says to use null)", async () => {
    mockBySlug.mockResolvedValue(
      baseMovie({}, { pagePalette: { wash: "#111111", columnWash: "#222222", accent: "#333333", heroBloom: "#444444" } }),
    );
    await run(updateMovieInfo, form({ slug: "ratatouille" }));
    const meta = override().metadata;
    expect(meta.pagePalette).toBeNull();
    expect(meta.pagePaletteDark).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resyncMovieFromImdb", () => {
  type OmdbBody = Record<string, unknown>;
  const FULL_OMDB: OmdbBody = {
    Response: "True",
    Title: "Ratatouille",
    Year: "2007",
    Type: "movie",
    Runtime: "111 min",
    Genre: "Animation, Comedy",
    Plot: "A rat cooks.",
    Poster: "https://p.example/new.jpg",
    Rated: "G",
    Director: "Brad Bird",
    Writer: "Brad Bird",
    Actors: "Patton Oswalt",
    imdbRating: "8.1",
    imdbVotes: "900,000",
    Metascore: "96",
    Awards: "Won 1 Oscar",
    Language: "English",
    Country: "United States, France",
  };

  type Plan = {
    omdb?: OmdbBody | "http-error" | "throw";
    seasons?: Record<string, number>;
    trivia?: string[] | "http-error" | "no-title" | "empty";
    reviews?: unknown[] | "http-error";
    requireReferer?: boolean;
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  function install(plan: Plan = {}) {
    fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "www.omdbapi.com") {
        const season = url.searchParams.get("Season");
        if (season) {
          const n = plan.seasons?.[season];
          return n === undefined
            ? Response.json({ Response: "False" })
            : Response.json({ Response: "True", Episodes: Array.from({ length: n }, () => ({})) });
        }
        if (plan.omdb === "throw") throw new TypeError("net");
        if (plan.omdb === "http-error") return new Response("x", { status: 500 });
        return Response.json(plan.omdb ?? FULL_OMDB);
      }
      if (url.hostname === "api.graphql.imdb.com") {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (plan.requireReferer && headers.Referer !== "https://www.imdb.com/") {
          return new Response("forbidden", { status: 403 });
        }
        const q = JSON.parse(String(init!.body)).query as string;
        if (q.includes("trivia(")) {
          const t = plan.trivia;
          if (t === "http-error") return new Response("x", { status: 500 });
          if (t === "no-title") return Response.json({ data: { title: null } });
          if (t === "empty" || t === undefined) return Response.json({ data: { title: { trivia: { edges: [] } } } });
          return Response.json({
            data: {
              title: {
                trivia: { edges: t.map((html) => ({ node: { displayableArticle: { body: { plaidHtml: html } } } })) },
              },
            },
          });
        }
        if (q.includes("reviews(")) {
          if (plan.reviews === "http-error") return new Response("x", { status: 500 });
          return Response.json({
            data: { title: { reviews: { edges: (plan.reviews ?? []).map((node) => ({ node })) } } },
          });
        }
      }
      return new Response("?", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  const params = (url: string) => new URL(url, "http://x").searchParams;
  const resync = () => run(resyncMovieFromImdb, form({ slug: "ratatouille" }));
  const review = (id: string, text: string, rating?: number) => ({
    id,
    author: { nickName: `u${id}` },
    summary: { originalText: `s${id}` },
    text: { originalText: { plainText: text } },
    authorRating: rating,
    submissionDate: "2020-01-01",
  });

  beforeEach(() => {
    process.env.OMDB_API_KEY = "omdb-key";
    install();
  });

  it("requires a moderator session", async () => {
    h.session = null;
    expect((await resync()).redirect).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("an unknown slug bounces to the catalog", async () => {
    mockBySlug.mockResolvedValue(undefined);
    expect((await resync()).redirect).toBe("/#catalog");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without an OMDb key it clears the override and reports resync-no-key (no network)", async () => {
    delete process.env.OMDB_API_KEY;
    const r = await resync();
    expect(r.redirect).toBe("/movies/ratatouille?toast=resync-no-key");
    expect(mockClear).toHaveBeenCalledWith("m-1");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http-error", "throw", { Response: "False", Error: "Incorrect IMDb ID." }] as const)(
    "OMDb %j reports resync-failed and leaves the movie untouched",
    async (omdb) => {
      install({ omdb: omdb as never });
      const r = await resync();
      expect(r.redirect).toBe("/movies/ratatouille?toast=resync-failed");
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockClear).not.toHaveBeenCalled();
    },
  );

  it("queries OMDb with the key, the IMDb id and the full plot", async () => {
    await resync();
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("apikey")).toBe("omdb-key");
    expect(url.searchParams.get("i")).toBe("tt0382932");
    expect(url.searchParams.get("plot")).toBe("full");
  });

  it("writes merged OMDb data and a complete-toast redirect", async () => {
    const r = await resync();
    expect(mockUpdate).toHaveBeenCalledWith("m-1", expect.any(Object));
    const o = override();
    expect(o).toMatchObject({
      title: "Ratatouille",
      releaseYear: 2007,
      runtimeMinutes: 111,
      genres: ["Animation", "Comedy"],
      summary: "A rat cooks.",
      posterUrl: "https://p.example/new.jpg",
    });
    expect(o.metadata).toMatchObject({
      rating: "G",
      director: "Brad Bird",
      cast: "Patton Oswalt",
      imdbRating: "8.1",
      metascore: "96",
      originalLanguage: "English",
      productionCountries: ["United States", "France"],
      metadataProvider: "OMDb via IMDb ID",
      syncedHeaderBannerUrl: "https://banner/b.jpg",
    });
    expect(o.metadata.syncedPalette).toBeTruthy();
    expect(o.metadata.syncedPaletteDark).toBeTruthy();
    expect(o.metadata.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const p = params(r.redirect!);
    expect(r.redirect!.startsWith("/movies/ratatouille?")).toBe(true);
    expect(p.get("toast")).toBe("resync-complete");
    expect(p.get("meta")).toBe("1");
    expect(p.get("related")).toBe("0");
    expect(p.get("videos")).toBe("0");
    expect(p.get("images")).toBe("0");
    expect(mockRevalidate).toHaveBeenCalledWith("/movies/ratatouille");
    expect(mockRevalidate).toHaveBeenCalledWith("/moderation");
  });

  it("forces a refresh of banner/palette using the freshly-synced poster", async () => {
    await resync();
    const [arg, opts] = mockVisuals.mock.calls[0]!;
    expect((arg as { posterUrl: string }).posterUrl).toBe("https://p.example/new.jpg");
    expect(opts).toEqual({ forceRefresh: true });
    expect(mockBackdrop).toHaveBeenCalledWith({ tmdbId: undefined, imdbId: "tt0382932", forceRefresh: true });
  });

  it("'N/A' OMDb fields do not overwrite existing values", async () => {
    install({
      omdb: { Response: "True", Title: "N/A", Year: "2007", Runtime: "N/A", Genre: "N/A", Plot: "N/A", Poster: "N/A", Rated: "N/A", Director: "N/A", Country: "N/A" },
    });
    await resync();
    const o = override();
    for (const k of ["title", "runtimeMinutes", "genres", "summary", "posterUrl"]) expect(o).not.toHaveProperty(k);
    expect(o.metadata.rating).toBe("G");
    expect(o.metadata.productionCountries).toEqual(["US"]);
  });

  it("stores a TMDB backdrop and reports tmdbbanner=ok / failed / not-configured", async () => {
    mockBackdrop.mockResolvedValue("https://tmdb/back.jpg");
    let r = await resync();
    expect(override().backdropUrl).toBe("https://tmdb/back.jpg");
    expect(params(r.redirect!).get("tmdbbanner")).toBe("ok");

    mockBackdrop.mockResolvedValue(null);
    r = await resync();
    expect(override()).not.toHaveProperty("backdropUrl");
    expect(params(r.redirect!).get("tmdbbanner")).toBe("not-configured");

    process.env.TMDB_BEARER_TOKEN = "tok";
    r = await resync();
    expect(params(r.redirect!).get("tmdbbanner")).toBe("failed");
  });

  describe("rat facts", () => {
    it("keeps up to three rat-mentioning trivia entries and reports the count", async () => {
      install({ trivia: ["<p>A <b>rat</b> appears.</p>", "Unrelated", "Ratty kitchen", "More rats", "Even more rats"] });
      const r = await resync();
      const facts = override().metadata.ratFacts as string[];
      expect(facts).toEqual(["A rat appears.", "Ratty kitchen", "More rats"]);
      expect(params(r.redirect!).get("facts")).toBe("3");
    });

    it.each([
      ["empty", "error"],
      ["no-title", "error"],
      ["http-error", "error"],
    ] as const)("trivia %s => trivia=%s", async (trivia, expected) => {
      install({ trivia });
      const r = await resync();
      expect(params(r.redirect!).get("trivia")).toBe(expected);
      expect(override().metadata).not.toHaveProperty("ratFacts");
    });

    it("trivia without any rat mention => trivia=none", async () => {
      install({ trivia: ["Shot in Paris.", "Won awards."] });
      const r = await resync();
      expect(params(r.redirect!).get("trivia")).toBe("none");
    });

    it.fails("BUG: the IMDb GraphQL trivia request omits the Referer header IMDb requires (403), so rat facts always fail here", async () => {
      install({ requireReferer: true, trivia: ["A rat appears."] });
      const r = await resync();
      expect(params(r.redirect!).get("facts")).toBe("1");
    });

    it.fails("BUG: the IMDb GraphQL reviews request omits the Referer header IMDb requires (403), so reviews always come back empty here", async () => {
      install({ requireReferer: true, reviews: [review("1", "rat!")] });
      const r = await resync();
      expect(params(r.redirect!).get("reviews")).toBe("1");
    });
  });

  describe("reviews", () => {
    it("lists rat-mentioning reviews first and reports counts", async () => {
      install({
        reviews: [review("1", "Nice film", 8), review("2", "The rats are great", 9), review("3", "Ratty kitchen", 7)],
      });
      const r = await resync();
      const reviews = override().metadata.imdbReviews as { id: string; mentionsRat: boolean; rating?: number }[];
      expect(reviews.map((x) => x.id)).toEqual(["2", "3", "1"]);
      expect(reviews[0]!.rating).toBe(9);
      expect(params(r.redirect!).get("reviews")).toBe("3");
      expect(params(r.redirect!).get("ratreviews")).toBe("2");
    });

    it("no rat reviews => no ratreviews param; none at all => reviews=0 and key omitted", async () => {
      install({ reviews: [review("1", "Nice film")] });
      let r = await resync();
      expect(params(r.redirect!).has("ratreviews")).toBe(false);
      install({ reviews: [] });
      r = await resync();
      expect(params(r.redirect!).get("reviews")).toBe("0");
      expect(override().metadata).not.toHaveProperty("imdbReviews");
    });

    it("skips empty reviews and strips HTML", async () => {
      install({
        reviews: [
          { id: "e", summary: { originalText: "" }, text: { originalText: { plainText: "" } } },
          review("1", "<b>bold</b> text"),
        ],
      });
      await resync();
      const reviews = override().metadata.imdbReviews as { id: string; text: string }[];
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.text).not.toContain("<b>");
    });

    it("an HTTP error yields no reviews rather than failing the resync", async () => {
      install({ reviews: "http-error" });
      const r = await resync();
      expect(params(r.redirect!).get("toast")).toBe("resync-complete");
    });
  });

  describe("related + media", () => {
    it("persists related titles, videos and images and reports counts", async () => {
      mockRelated.mockResolvedValue([{ id: "tt1", title: "R" }] as never);
      mockMedia.mockResolvedValue({
        videos: [{ id: "v1", name: "T" }],
        images: [{ id: "i1", url: "u" }, { id: "i2", url: "u2" }],
      } as never);
      const r = await resync();
      const meta = override().metadata;
      expect(meta.imdbRelated).toHaveLength(1);
      expect(meta.imdbVideos).toHaveLength(1);
      expect(meta.imdbImages).toHaveLength(2);
      const p = params(r.redirect!);
      expect([p.get("related"), p.get("videos"), p.get("images")]).toEqual(["1", "1", "2"]);
    });
  });

  describe("series handling", () => {
    it("sums episodes across seasons and redirects to /shows once the type is series", async () => {
      install({
        omdb: { ...FULL_OMDB, Type: "series", totalSeasons: "3", Year: "2010–2015" },
        seasons: { 1: 2, 2: 3, 3: 4 },
      });
      const r = await resync();
      expect(r.redirect!.startsWith("/shows/ratatouille?")).toBe(true);
      const snap = override().metadata.syncSnapshot;
      expect(snap).toMatchObject({ Type: "series", totalSeasons: "3", totalEpisodes: 9, Year: "2010–2015" });
    });

    it("a movie that becomes a series (and vice versa) is routed by the NEW type", async () => {
      mockBySlug.mockResolvedValue(baseMovie({}, { syncSnapshot: { Type: "series" } }));
      install({ omdb: { ...FULL_OMDB, Type: "movie" } });
      const r = await resync();
      expect(r.redirect!.startsWith("/movies/ratatouille?")).toBe(true);
    });

    it("caps season lookups at 200", async () => {
      install({ omdb: { ...FULL_OMDB, Type: "series", totalSeasons: "500" } });
      await resync();
      const seasonCalls = fetchMock.mock.calls.filter(([u]) => new URL(String(u)).searchParams.has("Season"));
      expect(seasonCalls).toHaveLength(200);
    });

    it("no season requests without a valid season count", async () => {
      await resync();
      expect(fetchMock.mock.calls.some(([u]) => new URL(String(u)).searchParams.has("Season"))).toBe(false);
    });
  });

  describe("change detection", () => {
    it("reports every field as changed on the first sync", async () => {
      const r = await resync();
      expect(Number(params(r.redirect!).get("changed"))).toBeGreaterThan(5);
      expect(override().metadata.lastSyncChangedFields).toContain("Title");
    });

    it("reports nothing changed when the stored snapshot already matches", async () => {
      await resync();
      const snapshot = override().metadata.syncSnapshot;
      mockBySlug.mockResolvedValue(baseMovie({}, { syncSnapshot: snapshot }));
      mockUpdate.mockClear();
      const r = await resync();
      expect(params(r.redirect!).get("changed")).toBe("0");
      expect(override().metadata.lastSyncChangedFields).toEqual([]);
    });

    it("labels only the fields that differ", async () => {
      await resync();
      const snapshot = { ...override().metadata.syncSnapshot, imdbRating: "7.0" };
      mockBySlug.mockResolvedValue(baseMovie({}, { syncSnapshot: snapshot }));
      const r = await resync();
      expect(params(r.redirect!).get("changed")).toBe("1");
      expect(override().metadata.lastSyncChangedFields).toEqual(["IMDb score"]);
    });
  });

  it("propagates a store failure (no success redirect)", async () => {
    mockUpdate.mockRejectedValue(new Error("db down"));
    await expect(resync()).rejects.toThrow("db down");
  });
});
