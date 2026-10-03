import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTmdbBackdropUrl, fetchTmdbYoutubeTrailerKey } from "@/lib/tmdb-banner";

const ENV = ["TMDB_READ_ACCESS_TOKEN", "TMDB_API_READ_ACCESS_TOKEN", "TMDB_BEARER_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};

type Handler = (url: URL, init: RequestInit & { next?: { revalidate: number } }) => Response | Promise<Response> | "throw";
let handler: Handler;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TMDB_READ_ACCESS_TOKEN = "tmdb-token";
  handler = () => json({}, 404);
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const out = await handler(new URL(String(input)), (init ?? {}) as never);
    if (out === "throw") throw new TypeError("fetch failed");
    return out;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const IMG = (p: string) => `https://image.tmdb.org/t/p/w1280${p}`;

describe("getTmdbBackdropUrl — preconditions", () => {
  it("returns null without any id and makes no request", async () => {
    expect(await getTmdbBackdropUrl({})).toBeNull();
    expect(await getTmdbBackdropUrl({ tmdbId: "  ", imdbId: "" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without a TMDB token and makes no request", async () => {
    delete process.env.TMDB_READ_ACCESS_TOKEN;
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["TMDB_API_READ_ACCESS_TOKEN", "TMDB_BEARER_TOKEN"])("accepts %s as the token", async (name) => {
    delete process.env.TMDB_READ_ACCESS_TOKEN;
    process.env[name] = "  alt-token  ";
    handler = () => json({ backdrop_path: "/a.jpg" });
    await getTmdbBackdropUrl({ tmdbId: "1" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer alt-token");
  });

  it("ignores a blank token", async () => {
    process.env.TMDB_READ_ACCESS_TOKEN = "   ";
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getTmdbBackdropUrl — id resolution", () => {
  it("uses a known TMDB id directly (no find call) and sends the bearer token", async () => {
    handler = () => json({ backdrop_path: "/abc.jpg" });
    expect(await getTmdbBackdropUrl({ tmdbId: " 2062 " })).toBe(IMG("/abc.jpg"));
    expect(urls()).toEqual(["https://api.themoviedb.org/3/movie/2062"]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { next?: unknown };
    expect(init.headers).toMatchObject({ Authorization: "Bearer tmdb-token", Accept: "application/json" });
    expect(init.next).toEqual({ revalidate: 86400 });
  });

  it("resolves an IMDb id via /find, preferring movie results", async () => {
    handler = (u) =>
      u.pathname.startsWith("/3/find/")
        ? json({ movie_results: [{ id: 55 }], tv_results: [{ id: 99 }] })
        : json({ backdrop_path: "/m.jpg" });
    expect(await getTmdbBackdropUrl({ imdbId: "tt0382932" })).toBe(IMG("/m.jpg"));
    expect(urls()[0]).toBe("https://api.themoviedb.org/3/find/tt0382932?external_source=imdb_id");
    expect(urls()[1]).toBe("https://api.themoviedb.org/3/movie/55");
  });

  it("falls back to TV results and queries the /tv endpoints", async () => {
    handler = (u) =>
      u.pathname.startsWith("/3/find/")
        ? json({ movie_results: [], tv_results: [{ id: 77 }] })
        : json({ backdrop_path: "/tv.jpg" });
    expect(await getTmdbBackdropUrl({ imdbId: "tt0903747" })).toBe(IMG("/tv.jpg"));
    expect(urls()[1]).toBe("https://api.themoviedb.org/3/tv/77");
  });

  it("extracts the IMDb id from a URL-ish string and lower-cases it", async () => {
    handler = () => json({ movie_results: [] });
    await getTmdbBackdropUrl({ imdbId: "https://imdb.com/title/TT0382932/" });
    expect(urls()[0]).toContain("/find/tt0382932?");
  });

  it("returns null for an unparseable IMDb id without any request", async () => {
    expect(await getTmdbBackdropUrl({ imdbId: "garbage" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when /find fails, throws, or matches nothing", async () => {
    handler = () => json({}, 500);
    expect(await getTmdbBackdropUrl({ imdbId: "tt0382932" })).toBeNull();
    handler = () => "throw";
    expect(await getTmdbBackdropUrl({ imdbId: "tt0382932" })).toBeNull();
    handler = () => json({ movie_results: [], tv_results: [] });
    expect(await getTmdbBackdropUrl({ imdbId: "tt0382932" })).toBeNull();
    handler = () => json({ movie_results: [{ id: "not-a-number" }] });
    expect(await getTmdbBackdropUrl({ imdbId: "tt0382932" })).toBeNull();
  });

  it("forceRefresh bypasses the cache and re-resolves through IMDb instead of trusting the stored id", async () => {
    handler = (u) =>
      u.pathname.startsWith("/3/find/") ? json({ movie_results: [{ id: 5 }] }) : json({ backdrop_path: "/n.jpg" });
    await getTmdbBackdropUrl({ tmdbId: "1", imdbId: "tt0382932", forceRefresh: true });
    expect(urls()[0]).toContain("/find/tt0382932");
    expect(urls()[1]).toBe("https://api.themoviedb.org/3/movie/5");
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as { cache?: string }).cache).toBe("no-store");
      expect((init as { next?: unknown }).next).toBeUndefined();
    }
  });

  it("URL-encodes the TMDB id so it cannot escape the path", async () => {
    handler = () => json({ backdrop_path: "/x.jpg" });
    await getTmdbBackdropUrl({ tmdbId: "1/../../account?api_key=x" });
    const url = urls()[0]!;
    expect(url).toBe("https://api.themoviedb.org/3/movie/1%2F..%2F..%2Faccount%3Fapi_key%3Dx");
  });
});

describe("getTmdbBackdropUrl — picking an image", () => {
  it("uses the detail backdrop_path when present and never calls /images", async () => {
    handler = () => json({ backdrop_path: "/d.jpg" });
    await getTmdbBackdropUrl({ tmdbId: "1" });
    expect(urls()).toHaveLength(1);
  });

  it("falls through to /images when detail has no backdrop or fails", async () => {
    handler = (u) =>
      u.pathname.endsWith("/images")
        ? json({ backdrops: [{ file_path: "/i.jpg", width: 1920, vote_average: 5 }] })
        : json({ backdrop_path: null });
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBe(IMG("/i.jpg"));
    handler = (u) =>
      u.pathname.endsWith("/images")
        ? json({ backdrops: [{ file_path: "/i2.jpg", width: 1920 }] })
        : json({}, 500);
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBe(IMG("/i2.jpg"));
  });

  it("prefers the best-voted large (>=1280px) image", async () => {
    handler = (u) =>
      u.pathname.endsWith("/images")
        ? json({
            backdrops: [
              { file_path: "/small-popular.jpg", width: 800, vote_average: 10 },
              { file_path: "/big-low.jpg", width: 1920, vote_average: 2 },
              { file_path: "/big-high.jpg", width: 1920, vote_average: 8 },
              { file_path: null, width: 3000, vote_average: 10 },
            ],
          })
        : json({}, 404);
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBe(IMG("/big-high.jpg"));
  });

  it("when nothing is >=1280px, falls back to the best weighted smaller image", async () => {
    handler = (u) =>
      u.pathname.endsWith("/images")
        ? json({
            backdrops: [
              { file_path: "/a.jpg", width: 500, vote_average: 1 },
              { file_path: "/b.jpg", width: 1000, vote_average: 1 },
              { file_path: null, width: 5000 },
            ],
          })
        : json({}, 404);
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBe(IMG("/b.jpg"));
  });

  it("returns null when every candidate lacks a file_path, or there are no backdrops", async () => {
    handler = (u) =>
      u.pathname.endsWith("/images") ? json({ backdrops: [{ file_path: null, width: 100 }] }) : json({}, 404);
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
    handler = (u) => (u.pathname.endsWith("/images") ? json({ backdrops: [] }) : json({}, 404));
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
    handler = (u) => (u.pathname.endsWith("/images") ? json(null) : json({}, 404));
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
  });

  it("returns null when /images fails or any request throws", async () => {
    handler = () => json({}, 500);
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
    handler = () => "throw";
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
    handler = () => new Response("<html>not json</html>", { status: 200 });
    expect(await getTmdbBackdropUrl({ tmdbId: "1" })).toBeNull();
  });
});

describe("fetchTmdbYoutubeTrailerKey", () => {
  const vids = (results: unknown[]) => (u: URL) =>
    u.pathname.endsWith("/videos") ? json({ results }) : json({ movie_results: [{ id: 1 }] });

  it("returns undefined without a token or any request", async () => {
    delete process.env.TMDB_READ_ACCESS_TOKEN;
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: "tt0382932", tmdbId: "1" })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the title cannot be resolved", async () => {
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: undefined })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers official YouTube trailer > any trailer > official teaser > any YouTube video", async () => {
    const base = [
      { key: "vimeo", site: "Vimeo", type: "Trailer", official: true },
      { key: "clip", site: "YouTube", type: "Clip" },
      { key: "teaser", site: "YouTube", type: "Teaser", official: true },
      { key: "trailer", site: "YouTube", type: "Trailer", official: false },
      { key: "official", site: "YouTube", type: "Trailer", official: true },
    ];
    handler = vids(base);
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBe("official");
    handler = vids(base.filter((v) => v.key !== "official"));
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBe("trailer");
    handler = vids(base.filter((v) => !["official", "trailer"].includes(v.key)));
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBe("teaser");
    handler = vids(base.filter((v) => v.key === "clip" || v.key === "vimeo"));
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBe("clip");
  });

  it("ignores non-YouTube videos and returns undefined when none qualify", async () => {
    handler = vids([{ key: "v", site: "Vimeo", type: "Trailer", official: true }]);
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBeUndefined();
    handler = vids([]);
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBeUndefined();
    handler = () => json({});
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBeUndefined();
  });

  it("returns undefined on HTTP errors, bad JSON and network failures", async () => {
    handler = () => json({}, 500);
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBeUndefined();
    handler = () => new Response("nope", { status: 200 });
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBeUndefined();
    handler = () => "throw";
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: undefined, tmdbId: "1" })).toBeUndefined();
  });

  it("uses the TV endpoint when IMDb resolves to a series", async () => {
    handler = (u) =>
      u.pathname.startsWith("/3/find/")
        ? json({ tv_results: [{ id: 9 }] })
        : json({ results: [{ key: "tvkey", site: "YouTube", type: "Trailer", official: true }] });
    expect(await fetchTmdbYoutubeTrailerKey({ imdbId: "tt0903747", tmdbId: undefined })).toBe("tvkey");
    expect(urls().at(-1)).toBe("https://api.themoviedb.org/3/tv/9/videos");
  });

  it("forceRefresh uses no-store caching", async () => {
    handler = vids([{ key: "k", site: "YouTube", type: "Trailer" }]);
    await fetchTmdbYoutubeTrailerKey({ imdbId: "tt0382932", tmdbId: "1", forceRefresh: true });
    for (const [, init] of fetchMock.mock.calls) expect((init as { cache?: string }).cache).toBe("no-store");
  });
});
