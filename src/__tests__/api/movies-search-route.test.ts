/**
 * GET /api/movies/search — autocomplete for the submit form. OMDb via fetch,
 * seed catalogue via the (mocked) DB layer. No network, no DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/movie-edit-store", () => ({ getDeletedMovieIds: vi.fn() }));
vi.mock("@/lib/movie-catalog", () => ({ getCatalogMovies: vi.fn() }));

import { GET } from "@/app/api/movies/search/route";
import { getDeletedMovieIds } from "@/lib/movie-edit-store";
import { getCatalogMovies } from "@/lib/movie-catalog";
import type { Movie } from "@/lib/whererat";

const mockDeleted = vi.mocked(getDeletedMovieIds);
const mockCatalog = vi.mocked(getCatalogMovies);

const API_KEY = "test-omdb-key-123";

function movie(
  id: string,
  title: string,
  imdb: string,
  extra: Partial<Movie> & { snapshot?: Record<string, unknown> } = {},
): Movie {
  const { snapshot, ...rest } = extra;
  return {
    id,
    slug: id,
    title,
    releaseYear: 2007,
    runtimeMinutes: 111,
    genres: ["Animation", "Comedy"],
    posterTone: "bg-amber-700",
    posterUrl: `https://img.example/${id}.jpg`,
    backdropUrl: "",
    posterAlt: title,
    externalIds: { imdb },
    summary: `${title} summary`,
    metadata: {
      tagline: "",
      rating: "PG",
      director: "",
      originalLanguage: "en",
      productionCountries: [],
      metadataProvider: "IMDb seed",
      lastSyncedAt: "",
      imdbRating: "8.1",
      syncSnapshot: snapshot,
    },
    ...rest,
  } as unknown as Movie;
}

type OmdbItem = { Title: string; Year: string; imdbID: string; Poster: string; Type: string };
const item = (title: string, imdbID: string, over: Partial<OmdbItem> = {}): OmdbItem => ({
  Title: title,
  Year: "2007",
  imdbID,
  Poster: "https://p.example/x.jpg",
  Type: "movie",
  ...over,
});

type FetchPlan = {
  /** keyed by the `s=` search string; missing key => Response False */
  search?: Record<string, OmdbItem[] | "http-error" | "throw" | "bad-json" | { Error: string }>;
  /** keyed by imdbID; missing => Response False */
  details?: Record<string, Record<string, unknown> | "http-error" | "throw">;
};

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(plan: FetchPlan) {
  fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    const s = url.searchParams.get("s");
    const i = url.searchParams.get("i");
    if (s !== null) {
      const entry = plan.search?.[s];
      if (entry === "throw") throw new TypeError("fetch failed");
      if (entry === "http-error") return new Response("nope", { status: 500 });
      if (entry === "bad-json") return new Response("<html>oops</html>", { status: 200 });
      if (entry && !Array.isArray(entry)) {
        return Response.json({ Response: "False", Error: entry.Error });
      }
      if (entry) return Response.json({ Response: "True", Search: entry });
      return Response.json({ Response: "False", Error: "Movie not found!" });
    }
    if (i !== null) {
      const entry = plan.details?.[i];
      if (entry === "throw") throw new TypeError("fetch failed");
      if (entry === "http-error") return new Response("nope", { status: 503 });
      if (entry) return Response.json({ Response: "True", ...entry });
      return Response.json({ Response: "False", Error: "Incorrect IMDb ID." });
    }
    return new Response("?", { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

const searchCalls = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u)))
    .filter((u) => u.searchParams.has("s"));
const detailCalls = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u)))
    .filter((u) => u.searchParams.has("i"));

async function call(qs: string) {
  const res = await GET(new Request(`http://localhost/api/movies/search${qs}`));
  return { res, body: await res.json() };
}

let savedKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedKey = process.env.OMDB_API_KEY;
  process.env.OMDB_API_KEY = API_KEY;
  mockDeleted.mockResolvedValue(new Set());
  mockCatalog.mockResolvedValue([]);
  installFetch({});
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OMDB_API_KEY;
  else process.env.OMDB_API_KEY = savedKey;
  vi.unstubAllGlobals();
});

describe("query validation", () => {
  it.each([["", "missing q"], ["?q=", "empty"], ["?q=%20%20", "whitespace"], ["?q=a", "one char"], ["?q=%20a%20", "one char padded"]])(
    "%s (%s) returns an empty result list without calling OMDb",
    async (qs) => {
      const { res, body } = await call(qs);
      expect(res.status).toBe(200);
      expect(body).toEqual({ configured: true, results: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reports configured:false for short queries when no API key is set", async () => {
    delete process.env.OMDB_API_KEY;
    const { body } = await call("?q=a");
    expect(body).toEqual({ configured: false, results: [] });
  });

  it("treats an empty-string API key as unconfigured and never calls OMDb", async () => {
    process.env.OMDB_API_KEY = "";
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt0382932")]);
    const { body } = await call("?q=ratatouille");
    expect(body.configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("seed catalogue (no OMDb key)", () => {
  beforeEach(() => {
    delete process.env.OMDB_API_KEY;
  });

  it("returns Seed results with the documented shape", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt0382932")]);
    const { res, body } = await call("?q=ratatouille");
    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.results).toEqual([
      {
        title: "Ratatouille",
        year: "2007",
        imdbId: "tt0382932",
        kind: "movie",
        posterUrl: "https://img.example/m1.jpg",
        runtime: "111 min",
        genre: "Animation, Comedy",
        rating: "PG",
        imdbRating: "8.1",
        plot: "Ratatouille summary",
        source: "Seed",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ranks an exact title above partial matches", async () => {
    mockCatalog.mockResolvedValue([
      movie("m1", "Rat Race Extended Cut Edition", "tt1"),
      movie("m2", "Rat Race", "tt2"),
    ]);
    const { body } = await call("?q=rat%20race");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt2", "tt1"]);
  });

  it("excludes soft-deleted movies", async () => {
    mockCatalog.mockResolvedValue([
      movie("gone", "Ratatouille", "tt1"),
      movie("kept", "Ratatouille 2", "tt2"),
    ]);
    mockDeleted.mockResolvedValue(new Set(["gone"]));
    const { body } = await call("?q=ratatouille");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt2"]);
  });

  it("matches on IMDb id", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Unrelated", "tt0382932"), movie("m2", "Other", "tt999")]);
    const { body } = await call("?q=tt0382932");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt0382932"]);
  });

  it("falls back to any-token matching (e.g. by release year)", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Zzz", "tt1")]);
    const { body } = await call("?q=1999%202007");
    expect(body.results).toHaveLength(1);
  });

  it("returns no results when nothing matches", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt1")]);
    const { body } = await call("?q=qqqqq");
    expect(body.results).toEqual([]);
  });

  it("caps results at 8", async () => {
    mockCatalog.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => movie(`m${i}`, `Rat ${i}`, `tt${i}`)),
    );
    const { body } = await call("?q=rat");
    expect(body.results).toHaveLength(8);
  });

  it("maps series with year range, seasons and episodes; omits runtime", async () => {
    mockCatalog.mockResolvedValue([
      movie("s1", "Rat Show", "tt5", {
        snapshot: { Type: "Series", Year: "2010-2015", totalSeasons: "5", totalEpisodes: "60" },
      }),
    ]);
    const { body } = await call("?q=rat%20show");
    expect(body.results[0]).toMatchObject({
      kind: "series",
      yearRange: "2010–2015",
      totalSeasons: 5,
      totalEpisodes: 60,
    });
    expect(body.results[0].runtime).toBeUndefined();
  });

  it("ignores junk season/episode counts", async () => {
    mockCatalog.mockResolvedValue([
      movie("s1", "Rat Show", "tt5", {
        snapshot: { Type: "series", totalSeasons: "N/A", episodeCount: "0" },
      }),
    ]);
    const { body } = await call("?q=rat%20show");
    expect(body.results[0].totalSeasons).toBeUndefined();
    expect(body.results[0].totalEpisodes).toBeUndefined();
  });

  it("reads alternate snapshot keys (year / TotalSeasons / episodeCount)", async () => {
    mockCatalog.mockResolvedValue([
      movie("s1", "Rat Show", "tt5", {
        snapshot: { Type: "series", year: "2001-", TotalSeasons: "3", episodeCount: 12 },
      }),
    ]);
    const { body } = await call("?q=rat%20show");
    expect(body.results[0]).toMatchObject({ yearRange: "2001–", totalSeasons: 3, totalEpisodes: 12 });
  });

  it("folds roman numerals so 'Evil Dead 2' finds 'Evil Dead II'", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Evil Dead II", "tt0092991")]);
    const { body } = await call("?q=Evil%20Dead%202");
    expect(body.results[0].imdbId).toBe("tt0092991");
  });

  it("does not treat regex metacharacters or SQL-ish text in q specially", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt1")]);
    for (const q of ["(.*)", "[a-", "' OR 1=1 --", "\\", "%00", "<script>"]) {
      const { res, body } = await call(`?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(body.results)).toBe(true);
    }
  });
});

describe("OMDb search", () => {
  it("returns normalised results merged with detail lookups", async () => {
    installFetch({
      search: { Ratatouille: [item("Ratatouille", "tt0382932", { Poster: "N/A" })] },
      details: {
        tt0382932: {
          Title: "Ratatouille",
          Year: "2007",
          imdbID: "tt0382932",
          Poster: "https://p.example/detail.jpg",
          Runtime: "111 min",
          Genre: "Animation",
          Rated: "G",
          imdbRating: "8.1",
          Plot: "A rat cooks.",
          Type: "movie",
        },
      },
    });
    const { res, body } = await call("?q=Ratatouille");
    expect(res.status).toBe(200);
    expect(body).toEqual({
      configured: true,
      hasMore: false,
      page: 1,
      results: [
        {
          title: "Ratatouille",
          year: "2007",
          imdbId: "tt0382932",
          kind: "movie",
          posterUrl: "https://p.example/detail.jpg",
          runtime: "111 min",
          genre: "Animation",
          rating: "G",
          imdbRating: "8.1",
          plot: "A rat cooks.",
          source: "OMDb",
        },
      ],
    });
  });

  it("never leaks the API key in the response", async () => {
    installFetch({ search: { Ratatouille: [item("Ratatouille", "tt1")] } });
    const { body } = await call("?q=Ratatouille");
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("sends the key to OMDb as a parameter and the typed query as s=", async () => {
    installFetch({ search: { Ratatouille: [item("Ratatouille", "tt1")] } });
    await call("?q=%20%20Ratatouille%20");
    const [first] = searchCalls();
    expect(first!.hostname).toBe("www.omdbapi.com");
    expect(first!.searchParams.get("apikey")).toBe(API_KEY);
    expect(first!.searchParams.get("s")).toBe("Ratatouille");
    expect(first!.searchParams.has("page")).toBe(false);
  });

  it("collapses internal whitespace before searching", async () => {
    installFetch({ search: { "Rat Race": [item("Rat Race", "tt1")] } });
    await call("?q=Rat%20%20%20%20Race");
    expect(searchCalls()[0]!.searchParams.get("s")).toBe("Rat Race");
  });

  it("falls back to detail-less item data when a detail lookup is HTTP-error or Response:False", async () => {
    installFetch({
      search: {
        Ratatouille: [
          item("Ratatouille", "tt1", { Year: "2007" }),
          item("Ratatouille Two", "tt2", { Year: "2010" }),
        ],
      },
      details: { tt1: "http-error" },
    });
    const { res, body } = await call("?q=Ratatouille");
    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(r.runtime).toBeUndefined();
      expect(r.source).toBe("OMDb");
    }
    expect(body.results[0].year).toBe("2007");
  });

  it("turns N/A posters and ratings into empty / undefined", async () => {
    installFetch({
      search: { Rat: [item("Rat", "tt1", { Poster: "N/A" })] },
      details: { tt1: { Title: "Rat", Year: "2000", imdbID: "tt1", Poster: "N/A", imdbRating: "N/A", Type: "movie" } },
    });
    const { body } = await call("?q=Rat");
    expect(body.results[0].posterUrl).toBe("");
    expect(body.results[0].imdbRating).toBeUndefined();
  });

  it("maps series with an en-dash year range and total seasons", async () => {
    installFetch({
      search: { "Rat Show": [item("Rat Show", "tt9", { Type: "series", Year: "2010-2015" })] },
      details: {
        tt9: { Title: "Rat Show", Year: "2010-2015", imdbID: "tt9", Poster: "x", Type: "series", totalSeasons: "5" },
      },
    });
    const { body } = await call("?q=Rat%20Show");
    expect(body.results[0]).toMatchObject({ kind: "series", yearRange: "2010–2015", totalSeasons: 5 });
  });

  it("junk totalSeasons (N/A) becomes undefined", async () => {
    installFetch({
      search: { "Rat Show": [item("Rat Show", "tt9", { Type: "series" })] },
      details: { tt9: { Title: "Rat Show", Year: "2010", imdbID: "tt9", Poster: "x", Type: "series", totalSeasons: "N/A" } },
    });
    const { body } = await call("?q=Rat%20Show");
    expect(body.results[0].totalSeasons).toBeUndefined();
  });

  it("drops non-movie/series types (episodes, games)", async () => {
    installFetch({
      search: {
        Rat: [
          item("Rat Ep", "tt1", { Type: "episode" }),
          item("Rat Game", "tt2", { Type: "game" }),
          item("Rat Film", "tt3"),
        ],
      },
    });
    const { body } = await call("?q=Rat");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt3"]);
    expect(detailCalls().map((u) => u.searchParams.get("i"))).toEqual(["tt3"]);
  });

  it("hides titles whose IMDb id is in the deleted set (case-insensitive)", async () => {
    mockCatalog.mockResolvedValue([movie("gone", "Rat", "TT1")]);
    mockDeleted.mockResolvedValue(new Set(["gone"]));
    installFetch({ search: { Rat: [item("Rat", "tt1"), item("Rat Two", "tt2")] } });
    const { body } = await call("?q=Rat");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt2"]);
  });

  it("boosts titles already in the catalogue over equally-scored ones", async () => {
    mockCatalog.mockResolvedValue([movie("c", "Rat Beta", "tt2")]);
    installFetch({ search: { Rat: [item("Rat Alpha", "tt1"), item("Rat Beta", "tt2")] } });
    const { body } = await call("?q=Rat");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt2", "tt1"]);
  });

  it("does not boost catalogue entries that are soft-deleted", async () => {
    mockCatalog.mockResolvedValue([movie("c", "Rat Beta", "tt2")]);
    mockDeleted.mockResolvedValue(new Set(["other"]));
    installFetch({ search: { Rat: [item("Rat Alpha", "tt1"), item("Rat Beta", "tt2")] } });
    const { body } = await call("?q=Rat");
    expect(body.results[0].imdbId).toBe("tt2");
  });

  it("sinks poster-less stub entries below real records", async () => {
    installFetch({
      search: { Rat: [item("Rat Alpha", "tt1", { Poster: "N/A" }), item("Rat Beta", "tt2")] },
    });
    const { body } = await call("?q=Rat");
    expect(body.results.map((r: { imdbId: string }) => r.imdbId)).toEqual(["tt2", "tt1"]);
  });

  it("prefers an exact title match", async () => {
    installFetch({
      search: { Rat: [item("Rat Pack Stories Of Long Ago", "tt1"), item("Rat", "tt2")] },
    });
    const { body } = await call("?q=Rat");
    expect(body.results[0].imdbId).toBe("tt2");
  });

  it("caps visible results and detail lookups at 10", async () => {
    installFetch({
      search: { Rat: Array.from({ length: 10 }, (_, i) => item(`Rat ${i}`, `tt${i}`)) },
    });
    const { body } = await call("?q=Rat");
    expect(body.results.length).toBeLessThanOrEqual(10);
    expect(detailCalls().length).toBeLessThanOrEqual(10);
  });
});

describe("pagination", () => {
  it("hasMore is true when OMDb returns a full page of 10", async () => {
    installFetch({
      search: { Rat: Array.from({ length: 10 }, (_, i) => item(`Rat ${i}`, `tt${i}`)) },
    });
    const { body } = await call("?q=Rat");
    expect(body.hasMore).toBe(true);
  });

  it("hasMore is false for a short page", async () => {
    installFetch({ search: { Rat: [item("Rat", "tt1")] } });
    const { body } = await call("?q=Rat");
    expect(body.hasMore).toBe(false);
  });

  it("passes ?page=N to OMDb and echoes it", async () => {
    installFetch({ search: { Rat: [item("Rat", "tt1")] } });
    const { body } = await call("?q=Rat&page=3");
    expect(body.page).toBe(3);
    expect(searchCalls()[0]!.searchParams.get("page")).toBe("3");
  });

  it.each(["abc", "0", "-4", ""])("clamps bad page %j to 1 (no page param sent)", async (page) => {
    installFetch({ search: { Rat: [item("Rat", "tt1")] } });
    const { body } = await call(`?q=Rat&page=${page}`);
    expect(body.page).toBe(1);
    expect(searchCalls()[0]!.searchParams.has("page")).toBe(false);
  });

  it("hasMore is judged before numeral-variant merging inflates the list", async () => {
    installFetch({
      search: {
        "Evil Dead 2": [item("Evil Dead 2", "tt1")],
        "Evil Dead ii": Array.from({ length: 10 }, (_, i) => item(`Evil Dead II ${i}`, `tt9${i}`)),
      },
    });
    const { body } = await call("?q=Evil%20Dead%202");
    expect(body.hasMore).toBe(false);
  });
});

describe("numeral variants", () => {
  it("also searches the roman-numeral spelling and merges de-duplicated results", async () => {
    installFetch({
      search: {
        "Evil Dead 2": [item("Evil Dead 2", "tt1")],
        "Evil Dead ii": [item("Evil Dead II", "tt0092991"), item("Evil Dead 2", "TT1")],
      },
    });
    const { body } = await call("?q=Evil%20Dead%202");
    const ids = body.results.map((r: { imdbId: string }) => r.imdbId.toLowerCase());
    expect(ids.sort()).toEqual(["tt0092991", "tt1"]);
    expect(searchCalls().map((u) => u.searchParams.get("s"))).toEqual(["Evil Dead 2", "Evil Dead ii"]);
  });

  it("makes no variant request when the query has no small numbers", async () => {
    installFetch({ search: { Rat: [item("Rat", "tt1")] } });
    await call("?q=Rat");
    expect(searchCalls()).toHaveLength(1);
  });

  it("a failing variant lookup doesn't break the primary results", async () => {
    installFetch({
      search: { "Evil Dead 2": [item("Evil Dead 2", "tt1")], "Evil Dead ii": "http-error" },
    });
    const { res, body } = await call("?q=Evil%20Dead%202");
    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(1);
  });
});

describe("fallback candidates", () => {
  it("retries progressively shorter strings until OMDb returns something", async () => {
    installFetch({ search: { Ratat: [item("Ratatouille", "tt1")] } });
    const { body } = await call("?q=Ratato");
    expect(searchCalls().map((u) => u.searchParams.get("s"))).toEqual(["Ratato", "Ratat"]);
    expect(body.results[0].imdbId).toBe("tt1");
  });

  it("drops trailing words first for multi-word queries", async () => {
    installFetch({ search: { Rat: [item("Rat", "tt1")] } });
    await call("?q=Rat%20Zzz%20Qqq");
    expect(searchCalls().map((u) => u.searchParams.get("s")).slice(0, 3)).toEqual([
      "Rat Zzz Qqq",
      "Rat Zzz",
      "Rat",
    ]);
  });

  it("never makes more than 14 search requests, however long the query", async () => {
    installFetch({});
    await call(`?q=${"a".repeat(500)}`);
    expect(searchCalls().length).toBeLessThanOrEqual(14);
  });

  it("a very long query still answers 200 within the attempt cap", async () => {
    installFetch({});
    const { res } = await call(`?q=${"ab ".repeat(300)}`);
    expect(res.status).toBe(200);
    expect(searchCalls().length).toBeLessThanOrEqual(14);
  });

  // buildOmdbSearchCandidates() eagerly builds one joined/trimmed/regex-normalised prefix
  // per word and per character (O(n^2) work) although at most 14 are ever fetched. A
  // ~9k-char query (well inside a URL limit) costs ~3s of CPU per request. Counting
  // Array#join calls is a deterministic proxy for that eager candidate construction.
  it.fails("BUG: a long multi-word query eagerly builds one candidate per word although only 14 are ever fetched", async () => {
    installFetch({});
    const join = vi.spyOn(Array.prototype, "join");
    try {
      await call(`?q=${"ab ".repeat(400)}`);
      expect(join.mock.calls.length).toBeLessThan(200);
    } finally {
      join.mockRestore();
    }
  });

  it.fails("BUG: query length is not capped before it is forwarded to OMDb", async () => {
    installFetch({});
    await call(`?q=${"a".repeat(5000)}`);
    for (const u of searchCalls()) {
      expect(u.searchParams.get("s")!.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("OMDb failure handling", () => {
  it("502s with a stable error when every OMDb request fails at HTTP level", async () => {
    installFetch({ search: { Rat: "http-error" } });
    // every candidate string is missing from the plan => Response False, so force http errors:
    fetchMock.mockImplementation(async () => new Response("down", { status: 500 }));
    const { res, body } = await call("?q=Rat");
    expect(res.status).toBe(502);
    expect(body).toEqual({ configured: true, error: "Movie search failed.", results: [] });
  });

  it("falls back to the seed catalogue (with OMDb's error) when OMDb finds nothing", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt1")]);
    fetchMock = vi.fn(async () => Response.json({ Response: "False", Error: "Too many results." }));
    vi.stubGlobal("fetch", fetchMock);
    const { res, body } = await call("?q=Ratatouille");
    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.error).toBe("Too many results.");
    expect(body.results[0]).toMatchObject({ source: "Seed", imdbId: "tt1" });
  });

  it("reports 'Movie not found!' style errors with empty results when seed has nothing", async () => {
    const { res, body } = await call("?q=zzzzzz");
    expect(res.status).toBe(200);
    expect(body).toEqual({ configured: true, error: "Movie not found!", results: [] });
  });

  it("falls back to a default message when OMDb gives no error text", async () => {
    fetchMock = vi.fn(async () => Response.json({ Response: "False" }));
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call("?q=zzzzzz");
    expect(body.error).toBe("No titles found.");
  });

  it("treats Response:True with an empty Search list as a miss and keeps trying shorter strings", async () => {
    fetchMock = vi.fn(async () => Response.json({ Response: "True", Search: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { res } = await call("?q=zzzzzz");
    expect(res.status).toBe(200);
    expect(searchCalls().length).toBeGreaterThan(1);
  });

  it("an invalid-API-key error is surfaced but the seed catalogue is still offered", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt1")]);
    fetchMock = vi.fn(async () => Response.json({ Response: "False", Error: "Invalid API key!" }));
    vi.stubGlobal("fetch", fetchMock);
    const { body } = await call("?q=Ratatouille");
    expect(body.error).toBe("Invalid API key!");
    expect(body.results).toHaveLength(1);
  });

  it.fails("BUG: a network error (fetch rejects) on search should degrade to 502/seed results, not an unhandled throw", async () => {
    mockCatalog.mockResolvedValue([movie("m1", "Ratatouille", "tt1")]);
    fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://localhost/api/movies/search?q=Ratatouille"));
    expect([200, 502]).toContain(res.status);
  });

  it.fails("BUG: OMDb returning a non-JSON 200 body should degrade gracefully, not throw", async () => {
    installFetch({ search: { Ratatouille: "bad-json" } });
    const res = await GET(new Request("http://localhost/api/movies/search?q=Ratatouille"));
    expect([200, 502]).toContain(res.status);
  });

  it.fails("BUG: a failed detail lookup (fetch rejects) should not discard the whole result list", async () => {
    installFetch({
      search: { Ratatouille: [item("Ratatouille", "tt1"), item("Ratatouille 2", "tt2")] },
      details: { tt1: "throw" },
    });
    const res = await GET(new Request("http://localhost/api/movies/search?q=Ratatouille"));
    expect(res.status).toBe(200);
  });
});
