/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed captured override payloads */
/**
 * movie-imdb-sync.ts: IMDb GraphQL fetchers, OMDb merge and the catalog-wide
 * resync loop. fetch, the DB write, TMDB and palette extraction are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  updateOverride: vi.fn(),
  getCatalogMovies: vi.fn(),
  trailer: vi.fn(),
  extract: vi.fn(),
}));
vi.mock("@/lib/movie-edit-store", () => ({ updateMovieOverride: h.updateOverride }));
vi.mock("@/lib/movie-catalog", () => ({ getCatalogMovies: h.getCatalogMovies }));
vi.mock("@/lib/tmdb-banner", () => ({ fetchTmdbYoutubeTrailerKey: h.trailer }));
vi.mock("@/lib/movie-page-palette", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/movie-page-palette")>();
  return { ...actual, extractMoviePagePalette: h.extract };
});

import {
  fetchImdbMedia,
  fetchImdbRelated,
  syncMovieFromImdb,
  resyncAllCatalogMoviesFromImdb,
} from "@/lib/movie-imdb-sync";
import type { Movie } from "@/lib/whererat";

const PALETTE = { wash: "#fff9eb", columnWash: "#fffdf6", accent: "#ea580c", heroBloom: "#2b1a10" };

function movie(id: string, over: { imdb?: string; metadata?: Record<string, unknown>; poster?: string; tmdb?: string } = {}): Movie {
  return {
    id,
    slug: id,
    title: `Title ${id}`,
    releaseYear: 2000,
    runtimeMinutes: 90,
    genres: ["Drama"],
    posterTone: "bg-x",
    posterUrl: over.poster ?? "https://img.example/p.jpg",
    backdropUrl: "",
    posterAlt: "",
    externalIds: { imdb: over.imdb ?? "tt0382932", tmdb: over.tmdb },
    summary: "orig",
    metadata: {
      tagline: "",
      rating: "PG",
      director: "",
      originalLanguage: "en",
      productionCountries: [],
      metadataProvider: "IMDb seed",
      lastSyncedAt: "",
      ...(over.metadata ?? {}),
    },
  } as unknown as Movie;
}

type GraphqlData = Record<string, unknown>;
type Plan = {
  omdb?: Record<string, unknown> | "http-error" | "throw" | "bad-json";
  seasons?: Record<string, { Episodes?: unknown[] } | "http-error" | "throw">;
  trivia?: unknown[];
  reviews?: unknown[];
  related?: unknown[];
  videos?: unknown[];
  images?: unknown[];
  graphql?: "http-403" | "throw" | { errors: unknown[]; data?: GraphqlData };
};

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
const savedKey = process.env.OMDB_API_KEY;

function installFetch(plan: Plan = {}) {
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "www.omdbapi.com") {
      const season = url.searchParams.get("Season");
      if (season) {
        const s = plan.seasons?.[season];
        if (s === "throw") throw new TypeError("net");
        if (s === "http-error") return new Response("x", { status: 500 });
        return s ? Response.json({ Response: "True", ...s }) : Response.json({ Response: "False" });
      }
      const o = plan.omdb;
      if (o === "throw") throw new TypeError("net");
      if (o === "http-error") return new Response("x", { status: 500 });
      if (o === "bad-json") return new Response("<html>", { status: 200 });
      return o ? Response.json({ Response: "True", ...o }) : Response.json({ Response: "False" });
    }
    if (url.hostname === "api.graphql.imdb.com") {
      if (plan.graphql === "throw") throw new TypeError("net");
      if (plan.graphql === "http-403") return new Response("forbidden", { status: 403 });
      if (plan.graphql && "errors" in plan.graphql) return Response.json(plan.graphql);
      const q = JSON.parse(String(init!.body)).query as string;
      const edges = (nodes: unknown[] | undefined) => ({ edges: (nodes ?? []).map((node) => ({ node })) });
      if (q.includes("trivia(")) return Response.json({ data: { title: { trivia: edges(plan.trivia) } } });
      if (q.includes("reviews(")) return Response.json({ data: { title: { reviews: edges(plan.reviews) } } });
      if (q.includes("moreLikeThisTitles")) {
        return Response.json({ data: { title: { moreLikeThisTitles: edges(plan.related) } } });
      }
      return Response.json({
        data: { title: { primaryVideos: edges(plan.videos), images: edges(plan.images) } },
      });
    }
    return new Response("?", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const graphqlCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes("graphql.imdb.com")) as [string, RequestInit][];
const omdbCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("omdbapi.com"));
const written = () => h.updateOverride.mock.calls.at(-1)![1] as Record<string, any> & { metadata: Record<string, any> };

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.updateOverride.mockResolvedValue(undefined);
  h.trailer.mockResolvedValue(undefined);
  h.extract.mockResolvedValue(null);
  h.getCatalogMovies.mockResolvedValue([]);
  delete process.env.OMDB_API_KEY;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  installFetch();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OMDB_API_KEY;
  else process.env.OMDB_API_KEY = savedKey;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  warn.mockRestore();
});

describe("IMDb GraphQL transport", () => {
  it("POSTs JSON with a Referer header (IMDb 403s without it)", async () => {
    await fetchImdbRelated("tt0382932");
    const [url, init] = graphqlCalls()[0]!;
    expect(url).toBe("https://api.graphql.imdb.com/");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Referer: "https://www.imdb.com/",
    });
    expect(JSON.parse(String(init.body)).query).toContain('title(id: "tt0382932")');
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("every GraphQL-backed call carries the Referer (sync issues four of them)", async () => {
    await syncMovieFromImdb(movie("m1"));
    const calls = graphqlCalls();
    expect(calls).toHaveLength(4);
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>).Referer).toBe("https://www.imdb.com/");
    }
  });

  it("returns empty results and logs the status on a 403", async () => {
    installFetch({ graphql: "http-403" });
    expect(await fetchImdbRelated("tt0382932")).toEqual([]);
    expect(await fetchImdbMedia("tt0382932")).toEqual({ videos: [], images: [] });
    expect(warn.mock.calls.some(([m]: unknown[]) => String(m).includes("HTTP 403"))).toBe(true);
  });

  it("returns empty results on a network failure and logs it", async () => {
    installFetch({ graphql: "throw" });
    expect(await fetchImdbRelated("tt0382932")).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("logs GraphQL-level errors but still uses any data returned", async () => {
    installFetch({
      graphql: {
        errors: [{ message: "partial" }],
        data: { title: { moreLikeThisTitles: { edges: [{ node: { id: "tt1", titleText: { text: "X" } } }] } } },
      },
    });
    const out = await fetchImdbRelated("tt0382932");
    expect(out).toHaveLength(1);
    expect(warn.mock.calls.some(([m]: unknown[]) => String(m).includes("partial"))).toBe(true);
  });

  it.fails("BUG(latent): the IMDb id is interpolated into the GraphQL document unescaped (callers currently pass normalised ids)", async () => {
    await fetchImdbMedia('tt0382932") { id } evil: title(id: "tt0000001');
    const query = JSON.parse(String(graphqlCalls()[0]![1].body)).query as string;
    expect(query).not.toContain("evil: title");
  });
});

describe("fetchImdbRelated", () => {
  it("maps recommendation nodes and skips nodes without id or title", async () => {
    installFetch({
      related: [
        {
          id: "tt1",
          titleText: { text: "Willard" },
          releaseYear: { year: 2003 },
          primaryImage: { url: "https://img/w.jpg" },
          ratingsSummary: { aggregateRating: 6.4 },
        },
        { id: "tt2", titleText: { text: "Bare" } },
        { id: "tt3" },
        { titleText: { text: "No id" } },
        null,
      ],
    });
    expect(await fetchImdbRelated("tt0382932")).toEqual([
      { id: "tt1", title: "Willard", year: 2003, posterUrl: "https://img/w.jpg", rating: 6.4 },
      { id: "tt2", title: "Bare", year: undefined, posterUrl: undefined, rating: undefined },
    ]);
  });

  it("is empty when IMDb returns no data", async () => {
    installFetch({ related: [] });
    expect(await fetchImdbRelated("tt0382932")).toEqual([]);
  });
});

describe("fetchImdbMedia", () => {
  it("maps videos and images, tolerating missing optional fields", async () => {
    installFetch({
      videos: [
        { id: "vi1", name: { value: "Trailer" }, runtime: { value: 90 }, thumbnail: { url: "https://t/1.jpg" }, contentType: { displayName: { value: "Trailer" } } },
        { id: "vi2" },
        { name: { value: "No id" } },
      ],
      images: [
        { id: "ri1", url: "https://i/1.jpg", width: 800, height: 600, caption: { plainText: "Cap" } },
        { id: "ri2", url: "https://i/2.jpg", width: "800" },
        { id: "ri3" },
        { url: "https://i/4.jpg" },
      ],
    });
    const out = await fetchImdbMedia("tt0382932");
    expect(out.videos).toEqual([
      { id: "vi1", name: "Trailer", contentType: "Trailer", thumbnailUrl: "https://t/1.jpg", runtimeSeconds: 90 },
      { id: "vi2", name: "Video", contentType: undefined, thumbnailUrl: undefined, runtimeSeconds: undefined },
    ]);
    expect(out.images).toEqual([
      { id: "ri1", url: "https://i/1.jpg", width: 800, height: 600, caption: "Cap" },
      { id: "ri2", url: "https://i/2.jpg", width: undefined, height: undefined, caption: undefined },
    ]);
  });
});

describe("syncMovieFromImdb", () => {
  it("does nothing for a movie without an IMDb id", async () => {
    await syncMovieFromImdb(movie("m1", { imdb: "" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.updateOverride).not.toHaveBeenCalled();
  });

  it("without an OMDb key, skips OMDb entirely but still writes the IMDb-derived data", async () => {
    installFetch({ related: [{ id: "tt9", titleText: { text: "R" } }] });
    await syncMovieFromImdb(movie("m1"));
    expect(omdbCalls()).toHaveLength(0);
    expect(h.updateOverride).toHaveBeenCalledWith("m1", expect.any(Object));
    expect(written().metadata.imdbRelated).toHaveLength(1);
    expect(written()).not.toHaveProperty("title");
  });

  it("merges OMDb details into the override and metadata", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({
      omdb: {
        Title: "Ratatouille",
        Year: "2007",
        Runtime: "111 min",
        Genre: "Animation, Comedy, , Family",
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
      },
    });
    await syncMovieFromImdb(movie("m1"));
    const w = written();
    expect(w).toMatchObject({
      title: "Ratatouille",
      releaseYear: 2007,
      runtimeMinutes: 111,
      genres: ["Animation", "Comedy", "Family"],
      summary: "A rat cooks.",
      posterUrl: "https://p.example/new.jpg",
    });
    expect(w.metadata).toMatchObject({
      rating: "G",
      director: "Brad Bird",
      writers: "Brad Bird",
      cast: "Patton Oswalt",
      imdbRating: "8.1",
      imdbVotes: "900,000",
      metascore: "96",
      awards: "Won 1 Oscar",
      originalLanguage: "English",
      productionCountries: ["United States", "France"],
      metadataProvider: "OMDb via IMDb ID",
    });
    expect(w.metadata.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("requests OMDb with the key, the id and the full plot", async () => {
    process.env.OMDB_API_KEY = "secret-key";
    installFetch({ omdb: { Title: "T" } });
    await syncMovieFromImdb(movie("m1"));
    const url = new URL(String(omdbCalls()[0]![0]));
    expect(url.searchParams.get("apikey")).toBe("secret-key");
    expect(url.searchParams.get("i")).toBe("tt0382932");
    expect(url.searchParams.get("plot")).toBe("full");
  });

  it("treats 'N/A' OMDb fields as absent so existing values are preserved", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({
      omdb: { Title: "N/A", Year: "N/A", Runtime: "N/A", Genre: "N/A", Plot: "N/A", Poster: "N/A", Rated: "N/A", Director: "N/A", imdbRating: "N/A", Country: "N/A" },
    });
    await syncMovieFromImdb(movie("m1", { metadata: { rating: "PG-13", director: "Old Dir" } }));
    const w = written();
    for (const k of ["title", "runtimeMinutes", "genres", "summary", "posterUrl"]) expect(w).not.toHaveProperty(k);
    expect(w.metadata.rating).toBe("PG-13");
    expect(w.metadata.director).toBe("Old Dir");
    expect(w.metadata).not.toHaveProperty("imdbRating");
  });

  it("an unparseable Year keeps the current release year", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({ omdb: { Title: "T", Year: "TBD" } });
    await syncMovieFromImdb(movie("m1"));
    expect(written().releaseYear).toBe(2000);
  });

  it("a series year range uses the start year and records the raw range in the snapshot", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({ omdb: { Title: "S", Year: "2010–2015", Type: "series", totalSeasons: "2" }, seasons: { 1: { Episodes: [{}, {}, {}] }, 2: { Episodes: [{}, {}] } } });
    await syncMovieFromImdb(movie("m1"));
    expect(written().releaseYear).toBe(2010);
    expect(written().metadata.syncSnapshot).toMatchObject({
      Year: "2010–2015",
      Type: "series",
      totalSeasons: "2",
      totalEpisodes: 5,
    });
  });

  it("preserves existing snapshot keys and overlays new ones", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({ omdb: { Title: "T", Year: "2001" } });
    await syncMovieFromImdb(movie("m1", { metadata: { syncSnapshot: { Keep: "me", Year: "1999" } } }));
    expect(written().metadata.syncSnapshot).toMatchObject({ Keep: "me", Year: "2001" });
  });

  it("keeps existing metadata keys (e.g. a manual accent) through a sync", async () => {
    await syncMovieFromImdb(movie("m1", { metadata: { overrideAccent: "#123456", tagline: "tag" } }));
    expect(written().metadata).toMatchObject({ overrideAccent: "#123456", tagline: "tag" });
  });

  describe("season / episode counting", () => {
    it("skips failing seasons and sums the rest", async () => {
      process.env.OMDB_API_KEY = "k";
      installFetch({
        omdb: { Title: "S", Type: "series", totalSeasons: "4" },
        seasons: { 1: { Episodes: [{}, {}] }, 2: "http-error", 3: "throw", 4: { Episodes: [{}] } },
      });
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata.syncSnapshot.totalEpisodes).toBe(3);
    });

    it("caps per-season lookups at 20", async () => {
      process.env.OMDB_API_KEY = "k";
      installFetch({ omdb: { Title: "S", Type: "series", totalSeasons: "150" } });
      await syncMovieFromImdb(movie("m1"));
      const seasonCalls = omdbCalls().filter(([u]) => new URL(String(u)).searchParams.has("Season"));
      expect(seasonCalls).toHaveLength(20);
    });

    it("makes no season requests for movies / junk season counts", async () => {
      process.env.OMDB_API_KEY = "k";
      for (const totalSeasons of [undefined, "N/A", "0", "-3"]) {
        installFetch({ omdb: { Title: "M", totalSeasons } });
        await syncMovieFromImdb(movie("m1"));
        expect(omdbCalls().filter(([u]) => new URL(String(u)).searchParams.has("Season"))).toHaveLength(0);
        expect(written().metadata.syncSnapshot).not.toHaveProperty("totalEpisodes");
      }
    });

    it("reads TotalSeasons as an alternative key", async () => {
      process.env.OMDB_API_KEY = "k";
      installFetch({ omdb: { Title: "S", TotalSeasons: "1" }, seasons: { 1: { Episodes: [{}] } } });
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata.syncSnapshot).toMatchObject({ TotalSeasons: "1", totalEpisodes: 1 });
    });
  });

  describe("OMDb failures", () => {
    it.each(["http-error", "throw", "bad-json"] as const)("%s from OMDb does not throw and does not blank the movie", async (mode) => {
      process.env.OMDB_API_KEY = "k";
      installFetch({ omdb: mode, related: [{ id: "tt9", titleText: { text: "R" } }] });
      await expect(syncMovieFromImdb(movie("m1"))).resolves.toBeUndefined();
      const w = written();
      expect(w).not.toHaveProperty("title");
      expect(w).not.toHaveProperty("summary");
      expect(w.metadata.imdbRelated).toHaveLength(1);
    });

    it("Response:False from OMDb is treated as no data", async () => {
      process.env.OMDB_API_KEY = "k";
      installFetch({});
      await syncMovieFromImdb(movie("m1"));
      expect(written()).not.toHaveProperty("title");
    });
  });

  describe("reviews", () => {
    const review = (over: Record<string, unknown> = {}) => ({
      id: "rw1",
      author: { nickName: "Remy" },
      summary: { originalText: "Great" },
      text: { originalText: { plainText: "Loved the rat." } },
      authorRating: 9,
      submissionDate: "2003-04-12T00:00:00Z",
      ...over,
    });

    it("maps reviews, normalises dates, detects rodent mentions", async () => {
      installFetch({
        reviews: [
          review(),
          review({ id: "rw2", author: null, authorRating: "9", submissionDate: "5 April 2003", summary: { originalText: "Meh" }, text: { originalText: { plainText: "No vermin here? yes there is" } } }),
          review({ id: "rw3", submissionDate: "Sept 2003", text: { originalText: { plainText: "Plain" } }, summary: { originalText: "Plain" } }),
        ],
      });
      await syncMovieFromImdb(movie("m1"));
      const r = written().metadata.imdbReviews;
      expect(r).toHaveLength(3);
      expect(r[0]).toEqual({ id: "rw1", author: "Remy", summary: "Great", text: "Loved the rat.", rating: 9, date: "2003-04-12", mentionsRat: true });
      expect(r[1]).toMatchObject({ author: "Anonymous", rating: undefined, date: "2003-04-05", mentionsRat: true });
      expect(r[2]).toMatchObject({ date: "Sept 2003", mentionsRat: false });
    });

    it("drops reviews with neither summary nor text, and nodeless edges", async () => {
      installFetch({
        reviews: [review({ summary: null, text: null }), review({ id: "ok" }), null],
      });
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata.imdbReviews.map((x: { id: string }) => x.id)).toEqual(["ok"]);
    });

    it("strips HTML from review text", async () => {
      installFetch({ reviews: [review({ text: { originalText: { plainText: "<b>Bold</b> &amp; <i>nice</i><script>x()</script>" } } })] });
      await syncMovieFromImdb(movie("m1"));
      const t = written().metadata.imdbReviews[0].text as string;
      expect(t).not.toMatch(/<\/?(b|i)>/);
      expect(t).toContain("Bold & nice");
    });

    it("does not set imdbReviews when there are none", async () => {
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata).not.toHaveProperty("imdbReviews");
    });

    it.fails("BUG: numeric HTML entities other than &#39; (e.g. &#8217; &#x27;) are left undecoded in review text", async () => {
      installFetch({ reviews: [review({ summary: { originalText: "Don&#8217;t miss" }, text: { originalText: { plainText: "It&#x27;s fun" } } })] });
      await syncMovieFromImdb(movie("m1"));
      const r = written().metadata.imdbReviews[0];
      expect(r.summary).toBe("Don’t miss");
      expect(r.text).toBe("It's fun");
    });
  });

  describe("rat facts", () => {
    const fact = (html: string) => ({ displayableArticle: { body: { plaidHtml: html } } });

    it("keeps only trivia that mentions rodents, as plain text", async () => {
      installFetch({
        trivia: [
          fact("<p>The film features <b>rats</b> &amp; mice.</p>"),
          fact("<p>Shot in Paris.</p>"),
          fact(""),
          fact("Squirrel cameo"),
          null,
        ],
      });
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata.ratFacts).toEqual(["The film features rats & mice.", "Squirrel cameo"]);
    });

    it("caps the list at five entries", async () => {
      installFetch({ trivia: Array.from({ length: 12 }, (_, i) => fact(`Rat fact ${i}`)) });
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata.ratFacts).toHaveLength(5);
    });

    it("doesn't match words that merely contain 'rat' (rated, strategy, rather)", async () => {
      installFetch({ trivia: [fact("It was rated R, a strategic rather odd hit.")] });
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata).not.toHaveProperty("ratFacts");
    });
  });

  describe("palette and trailer", () => {
    it("stores a light palette plus derived dark one when extraction works", async () => {
      h.extract.mockResolvedValue(PALETTE);
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata.syncedPalette).toEqual(PALETTE);
      expect(written().metadata.syncedPaletteDark).toBeTruthy();
      expect(written().metadata.syncedPaletteDark).not.toEqual(PALETTE);
    });

    it("omits palettes if extraction returns null, and swallows extraction errors", async () => {
      await syncMovieFromImdb(movie("m1"));
      expect(written().metadata).not.toHaveProperty("syncedPalette");
      h.extract.mockRejectedValue(new Error("sharp exploded"));
      await expect(syncMovieFromImdb(movie("m1"))).resolves.toBeUndefined();
    });

    it("extracts from the OMDb poster (Amazon art upsized) in preference to the stored poster", async () => {
      process.env.OMDB_API_KEY = "k";
      installFetch({ omdb: { Title: "T", Poster: "https://m.media-amazon.com/images/M/x._V1_SX300.jpg" } });
      await syncMovieFromImdb(movie("m1", { poster: "https://old.example/p.jpg" }));
      expect(String(h.extract.mock.calls[0]![0])).toContain("media-amazon.com");
      expect(String(h.extract.mock.calls[0]![0])).toContain("_SX1280");
    });

    it("falls back to the stored poster for palette extraction without OMDb data", async () => {
      await syncMovieFromImdb(movie("m1", { poster: "https://old.example/p.jpg" }));
      expect(h.extract).toHaveBeenCalledWith("https://old.example/p.jpg");
    });

    it("stores the TMDB trailer key when present", async () => {
      h.trailer.mockResolvedValue("yt123");
      await syncMovieFromImdb(movie("m1", { tmdb: "42" }));
      expect(h.trailer).toHaveBeenCalledWith({ imdbId: "tt0382932", tmdbId: "42" });
      expect(written().metadata.youtubeTrailerKey).toBe("yt123");
    });
  });

  it("includes videos and images in metadata when found", async () => {
    installFetch({
      videos: [{ id: "vi1", name: { value: "T" } }],
      images: [{ id: "ri1", url: "https://i/1.jpg" }],
    });
    await syncMovieFromImdb(movie("m1"));
    expect(written().metadata.imdbVideos).toHaveLength(1);
    expect(written().metadata.imdbImages).toHaveLength(1);
  });

  it("completes with every upstream failing (best-effort)", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({ omdb: "throw", graphql: "throw" });
    await expect(syncMovieFromImdb(movie("m1"))).resolves.toBeUndefined();
  });

  it("propagates a failure to persist the override", async () => {
    h.updateOverride.mockRejectedValue(new Error("db down"));
    await expect(syncMovieFromImdb(movie("m1"))).rejects.toThrow("db down");
  });

  it.fails("BUG: when every upstream source fails, the movie is still stamped lastSyncedAt/'OMDb via IMDb ID' (and counted as synced), hiding the outage and demoting it in stale-first order", async () => {
    process.env.OMDB_API_KEY = "k";
    installFetch({ omdb: "http-error", graphql: "http-403" });
    await syncMovieFromImdb(movie("m1", { metadata: { lastSyncedAt: "2020-01-01", metadataProvider: "IMDb seed" } }));
    const wroteFreshStamp =
      h.updateOverride.mock.calls.length > 0 &&
      (written().metadata.lastSyncedAt !== "2020-01-01" || written().metadata.metadataProvider === "OMDb via IMDb ID");
    expect(wroteFreshStamp).toBe(false);
  });
});

describe("resyncAllCatalogMoviesFromImdb", () => {
  const ids = () => h.updateOverride.mock.calls.map(([id]) => id as string);
  const withSync = (id: string, lastSyncedAt: unknown) => movie(id, { metadata: { lastSyncedAt } });

  it("handles an empty catalogue", async () => {
    expect(await resyncAllCatalogMoviesFromImdb()).toEqual({ total: 0, synced: 0, errors: 0, truncated: false });
  });

  it("syncs everything by default and reports totals", async () => {
    h.getCatalogMovies.mockResolvedValue([movie("a"), movie("b"), movie("c")]);
    expect(await resyncAllCatalogMoviesFromImdb()).toEqual({ total: 3, synced: 3, errors: 0, truncated: false });
  });

  it("goes stale-first: never-synced titles, then oldest first", async () => {
    h.getCatalogMovies.mockResolvedValue([
      withSync("recent", "2026-03-01"),
      withSync("never", ""),
      withSync("old", "2020-01-01"),
      withSync("junk", "not-a-date"),
    ]);
    await resyncAllCatalogMoviesFromImdb();
    expect(ids().slice(0, 2).sort()).toEqual(["junk", "never"]);
    expect(ids().slice(2)).toEqual(["old", "recent"]);
  });

  it("when every title has a sync date, rotationSeed rotates the starting point", async () => {
    h.getCatalogMovies.mockResolvedValue([withSync("a", "2020-01-01"), withSync("b", "2021-01-01"), withSync("c", "2022-01-01")]);
    await resyncAllCatalogMoviesFromImdb({ rotationSeed: 1 });
    expect(ids()).toEqual(["b", "c", "a"]);
  });

  it("rotation handles negative, fractional, huge and non-finite seeds without crashing", async () => {
    h.getCatalogMovies.mockResolvedValue([withSync("a", "2020-01-01"), withSync("b", "2021-01-01"), withSync("c", "2022-01-01")]);
    for (const [seed, first] of [[-1, "c"], [4, "b"], [1.9, "b"], [Number.NaN, "a"], [Infinity, "a"]] as const) {
      h.updateOverride.mockClear();
      await resyncAllCatalogMoviesFromImdb({ rotationSeed: seed });
      expect(ids()[0]).toBe(first);
    }
  });

  it("ignores rotationSeed while any title has never been synced", async () => {
    h.getCatalogMovies.mockResolvedValue([withSync("a", "2020-01-01"), withSync("never", "")]);
    await resyncAllCatalogMoviesFromImdb({ rotationSeed: 1 });
    expect(ids()).toEqual(["never", "a"]);
  });

  it("counts individual failures as errors without aborting the run", async () => {
    h.getCatalogMovies.mockResolvedValue([movie("a"), movie("bad"), movie("c")]);
    h.updateOverride.mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("db");
    });
    expect(await resyncAllCatalogMoviesFromImdb()).toEqual({ total: 3, synced: 2, errors: 1, truncated: false });
    expect(h.updateOverride).toHaveBeenCalledTimes(3);
  });

  it("stops at the time budget and reports truncation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    h.getCatalogMovies.mockResolvedValue(["a", "b", "c", "d", "e"].map((id) => movie(id)));
    h.updateOverride.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5000);
    });
    const out = await resyncAllCatalogMoviesFromImdb({ maxDurationMs: 8000 });
    expect(out).toEqual({ total: 5, synced: 2, errors: 0, truncated: true });
  });

  it.each([0, -5, Number.NaN, Infinity, undefined])("budget %s means no deadline (full run)", async (budget) => {
    h.getCatalogMovies.mockResolvedValue([movie("a"), movie("b")]);
    const out = await resyncAllCatalogMoviesFromImdb({ maxDurationMs: budget as number | undefined });
    expect(out).toMatchObject({ synced: 2, truncated: false });
  });

  it("runs batches concurrently up to the requested level, clamped to 1..5", async () => {
    h.getCatalogMovies.mockResolvedValue(Array.from({ length: 12 }, (_, i) => movie(`m${i}`)));
    for (const [requested, expectedMax] of [[undefined, 1], [0, 1], [-4, 1], [3, 3], [99, 5]] as const) {
      let inflight = 0;
      let peak = 0;
      h.updateOverride.mockReset();
      h.updateOverride.mockImplementation(async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 1));
        inflight--;
      });
      await resyncAllCatalogMoviesFromImdb({ concurrency: requested });
      expect(peak).toBe(expectedMax);
    }
  });

  it("propagates a catalogue read failure", async () => {
    h.getCatalogMovies.mockRejectedValue(new Error("db down"));
    await expect(resyncAllCatalogMoviesFromImdb()).rejects.toThrow("db down");
  });
});
