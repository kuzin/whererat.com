/**
 * movie-catalog.ts against a fake pg pool: row mapping, image normalisation,
 * search (IMDb fast path -> trigram SQL -> FTS-only SQL -> in-memory), filters,
 * lookups and stats.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  movieRows: [] as Row[],
  searchRows: [] as Row[],
  trgmFails: false,
  ftsFails: false,
  moviesQueryFails: false,
  /** What the stats SQL would return: movie count, plus the single sightings aggregate row. */
  stats: { movies: "0", sightings: "0", spoilers: "0", rats: "0" } as Row,
  noStatsRow: false,
  query: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDbPool: () => ({ query: h.query }) }));

import {
  getCatalogMovies,
  getCatalogMovieBySlug,
  getCatalogMovieByImdbId,
  getCatalogMovieByTitleSearch,
  searchCatalogMovies,
  getCatalogGenres,
  getCatalogRodentTypes,
  getCatalogStatsWithCommunity,
  getCatalogListMovies,
  getCatalogIdentities,
  buildCatalogLookup,
  resolveMovieForSubmission,
  findCatalogMovieForSubmission,
} from "@/lib/movie-catalog";

const FALLBACK_POSTER = "https://placehold.co/600x900/292524/fef3c7/png?text=Community+Movie";
const FALLBACK_BACKDROP = "https://placehold.co/1200x600/292524/fef3c7/png?text=Community+Movie";

function row(id: string, title: string, imdb: string, over: Row = {}): Row {
  return {
    id,
    slug: `${id}-slug`,
    title,
    release_year: 2007,
    runtime_minutes: 111,
    genres: ["Animation"],
    poster_tone: "bg-amber-700",
    poster_url: "/p.png",
    backdrop_url: "/b.png",
    poster_alt: `${title} poster`,
    imdb_id: imdb,
    tmdb_id: null,
    summary: `${title} summary`,
    metadata: { rating: "G" },
    ...over,
  };
}

const isSearchSql = (sql: string) => sql.includes("plainto_tsquery");

beforeEach(() => {
  h.movieRows = [];
  h.searchRows = [];
  h.trgmFails = false;
  h.ftsFails = false;
  h.moviesQueryFails = false;
  h.stats = { movies: "0", sightings: "0", spoilers: "0", rats: "0" };
  h.noStatsRow = false;
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (isSearchSql(sql)) {
      const trgm = sql.includes("m.title % $1");
      if (trgm && h.trgmFails) throw new Error('function similarity(text, text) does not exist');
      if (!trgm && h.ftsFails) throw new Error("fts down");
      void params;
      return { rows: h.searchRows };
    }
    if (sql.includes("where slug = $1")) {
      if (h.moviesQueryFails) throw new Error("db down");
      return { rows: h.movieRows.filter((r) => r.slug === params?.[0]).slice(0, 1) };
    }
    if (sql.includes("order by created_at asc")) {
      if (h.moviesQueryFails) throw new Error("db down");
      return { rows: h.movieRows };
    }
    if (sql.includes("as rats")) {
      return {
        rows: h.noStatsRow
          ? []
          : [{ sightings: h.stats.sightings, spoilers: h.stats.spoilers, rats: h.stats.rats }],
      };
    }
    if (sql.includes("from movies")) return { rows: [{ count: h.stats.movies }] };
    throw new Error(`unexpected sql: ${sql}`);
  });
});

describe("getCatalogMovies", () => {
  it("maps snake_case rows to Movie objects", async () => {
    h.movieRows = [row("m1", "Ratatouille", "tt0382932", { tmdb_id: "2062" })];
    const [m] = await getCatalogMovies();
    expect(m).toEqual({
      id: "m1",
      slug: "m1-slug",
      title: "Ratatouille",
      releaseYear: 2007,
      runtimeMinutes: 111,
      genres: ["Animation"],
      posterTone: "bg-amber-700",
      posterUrl: "/p.png",
      backdropUrl: "/b.png",
      posterAlt: "Ratatouille poster",
      externalIds: { imdb: "tt0382932", tmdb: "2062" },
      summary: "Ratatouille summary",
      metadata: { rating: "G" },
    });
  });

  it("only reads non-deleted movies", async () => {
    await getCatalogMovies();
    expect(h.query.mock.calls[0]![0]).toMatch(/is_deleted = false/);
  });

  it("maps a null tmdb id to undefined", async () => {
    h.movieRows = [row("m1", "R", "tt0382932")];
    expect((await getCatalogMovies())[0]!.externalIds.tmdb).toBeUndefined();
  });

  it("drops rows without a valid IMDb id", async () => {
    h.movieRows = [
      row("ok", "Ok", "tt0382932"),
      row("empty", "Empty", ""),
      row("null", "Null", null as unknown as string),
      row("short", "Short", "tt123"),
      row("junk", "Junk", "not-an-id"),
    ];
    expect((await getCatalogMovies()).map((m) => m.id)).toEqual(["ok"]);
  });

  it("normalises IMDb ids (URL form, upper-case)", async () => {
    h.movieRows = [
      row("a", "A", "https://www.imdb.com/title/TT0382932/"),
      row("b", "B", "  TT0092991 "),
    ];
    expect((await getCatalogMovies()).map((m) => m.externalIds.imdb)).toEqual(["tt0382932", "tt0092991"]);
  });

  describe("image URL normalisation", () => {
    const poster = async (value: unknown) => {
      h.movieRows = [row("m", "M", "tt0382932", { poster_url: value })];
      return (await getCatalogMovies())[0]!.posterUrl;
    };

    it.each([
      ["/local/p.png", "/local/p.png"],
      ["https://img.example/p.jpg", "https://img.example/p.jpg"],
      ["HTTP://img.example/p.jpg", "HTTP://img.example/p.jpg"],
      ["  /padded.png  ", "/padded.png"],
    ])("keeps %j", async (input, expected) => {
      expect(await poster(input)).toBe(expected);
    });

    it.each([
      [""],
      ["   "],
      [null],
      [undefined],
      ["javascript:alert(1)"],
      ["data:image/png;base64,AAAA"],
      ["ftp://x/y.png"],
      ["relative/path.png"],
      ["file:///etc/passwd"],
    ])("falls back for %j", async (input) => {
      expect(await poster(input)).toBe(FALLBACK_POSTER);
    });

    it("uses a distinct fallback for backdrops", async () => {
      h.movieRows = [row("m", "M", "tt0382932", { backdrop_url: "" })];
      expect((await getCatalogMovies())[0]!.backdropUrl).toBe(FALLBACK_BACKDROP);
    });

    it("BUG: protocol-relative '//host/x.png' is accepted as a 'local' path (startsWith('/'))", async () => {
      expect(await poster("//evil.example/x.png")).toBe(FALLBACK_POSTER);
    });
  });

  it("propagates DB errors", async () => {
    h.moviesQueryFails = true;
    await expect(getCatalogMovies()).rejects.toThrow("db down");
  });
});

describe("lookups", () => {
  beforeEach(() => {
    h.movieRows = [row("m1", "Ratatouille", "tt0382932"), row("m2", "Evil Dead II", "tt0092991")];
  });

  it("getCatalogMovieBySlug finds by exact slug, else undefined", async () => {
    expect((await getCatalogMovieBySlug("m2-slug"))?.id).toBe("m2");
    expect(await getCatalogMovieBySlug("nope")).toBeUndefined();
    expect(await getCatalogMovieBySlug("")).toBeUndefined();
  });

  it("getCatalogMovieBySlug is a single bound-parameter row read, not a catalog scan", async () => {
    await getCatalogMovieBySlug("m1-slug' OR '1'='1");
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, params] = h.query.mock.calls[0]!;
    expect(sql).toMatch(/where slug = \$1 and is_deleted = false/);
    expect(sql).toMatch(/limit 1/);
    expect(params).toEqual(["m1-slug' OR '1'='1"]);
  });

  it("getCatalogMovieBySlug hides a row without a valid IMDb id, like the full catalog does", async () => {
    h.movieRows = [row("bad", "Broken", "not-an-id")];
    expect(await getCatalogMovieBySlug("bad-slug")).toBeUndefined();
  });

  it("getCatalogMovieByImdbId accepts bare ids, urls and mixed case", async () => {
    expect((await getCatalogMovieByImdbId("tt0382932"))?.id).toBe("m1");
    expect((await getCatalogMovieByImdbId("https://www.imdb.com/title/tt0092991/?ref_=x"))?.id).toBe("m2");
    expect((await getCatalogMovieByImdbId("TT0092991"))?.id).toBe("m2");
  });

  it("getCatalogMovieByImdbId returns undefined for garbage without hitting the DB", async () => {
    h.query.mockClear();
    expect(await getCatalogMovieByImdbId("not an id")).toBeUndefined();
    expect(await getCatalogMovieByImdbId("")).toBeUndefined();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("getCatalogMovieByImdbId returns undefined for a valid but unknown id", async () => {
    expect(await getCatalogMovieByImdbId("tt9999999")).toBeUndefined();
  });

  it("getCatalogMovieByTitleSearch returns the top search hit or undefined", async () => {
    h.searchRows = [{ id: "m2", rank: 1 }, { id: "m1", rank: 0.5 }];
    expect((await getCatalogMovieByTitleSearch("evil"))?.id).toBe("m2");
    h.searchRows = [];
    expect(await getCatalogMovieByTitleSearch("zzz")).toBeUndefined();
  });
});

describe("searchCatalogMovies", () => {
  beforeEach(() => {
    h.movieRows = [
      row("m1", "Ratatouille", "tt0382932", { genres: ["Animation", "Comedy"] }),
      row("m2", "Evil Dead II", "tt0092991", { genres: ["Horror"] }),
      row("m3", "Willard", "tt0368226", { genres: ["Horror", "Thriller"] }),
    ];
  });

  const ids = (movies: { id: string }[]) => movies.map((m) => m.id);
  const searchCalls = () => h.query.mock.calls.filter(([sql]) => isSearchSql(sql as string));

  it("with no query returns every movie and runs no search SQL", async () => {
    expect(ids(await searchCatalogMovies({}))).toEqual(["m1", "m2", "m3"]);
    expect(searchCalls()).toHaveLength(0);
  });

  it("treats a whitespace-only query as no query", async () => {
    expect(ids(await searchCatalogMovies({ query: "   " }))).toEqual(["m1", "m2", "m3"]);
    expect(searchCalls()).toHaveLength(0);
  });

  describe("genre filter", () => {
    it("filters by exact genre", async () => {
      expect(ids(await searchCatalogMovies({ genre: "Horror" }))).toEqual(["m2", "m3"]);
    });
    it("'all' and empty mean no filter", async () => {
      expect(await searchCatalogMovies({ genre: "all" })).toHaveLength(3);
      expect(await searchCatalogMovies({ genre: "" })).toHaveLength(3);
    });
    it("unknown genre yields nothing; matching is case-sensitive and exact", async () => {
      expect(await searchCatalogMovies({ genre: "Nope" })).toEqual([]);
      expect(await searchCatalogMovies({ genre: "horror" })).toEqual([]);
      expect(await searchCatalogMovies({ genre: "Horr" })).toEqual([]);
    });
  });

  describe("rodent filter", () => {
    it("restricts to the supplied movie ids", async () => {
      expect(ids(await searchCatalogMovies({ rodentMovieIds: new Set(["m1", "m3"]) }))).toEqual(["m1", "m3"]);
    });
    it("an empty set yields no movies (filter active, nothing matches)", async () => {
      expect(await searchCatalogMovies({ rodentMovieIds: new Set() })).toEqual([]);
    });
    it("combines with genre", async () => {
      const out = await searchCatalogMovies({ genre: "Horror", rodentMovieIds: new Set(["m1", "m3"]) });
      expect(ids(out)).toEqual(["m3"]);
    });
    it("applies to text searches too", async () => {
      h.searchRows = [{ id: "m1", rank: 1 }, { id: "m2", rank: 2 }];
      const out = await searchCatalogMovies({ query: "rat", rodentMovieIds: new Set(["m1"]) });
      expect(ids(out)).toEqual(["m1"]);
    });
  });

  describe("IMDb id fast path", () => {
    it("matches exact id case-insensitively without SQL search", async () => {
      expect(ids(await searchCatalogMovies({ query: "TT0092991" }))).toEqual(["m2"]);
      expect(searchCalls()).toHaveLength(0);
    });
    it("returns nothing for an unknown/partial tt id (no fuzzy fallthrough)", async () => {
      expect(await searchCatalogMovies({ query: "tt00929" })).toEqual([]);
      expect(await searchCatalogMovies({ query: "tt9999999" })).toEqual([]);
      expect(searchCalls()).toHaveLength(0);
    });
    it("respects the genre filter", async () => {
      expect(await searchCatalogMovies({ query: "tt0092991", genre: "Comedy" })).toEqual([]);
    });
  });

  describe("full-text search", () => {
    it("orders by SQL rank descending and drops movies SQL did not return", async () => {
      h.searchRows = [
        { id: "m3", rank: "0.2" },
        { id: "m2", rank: "0.9" },
      ];
      expect(ids(await searchCatalogMovies({ query: "rat" }))).toEqual(["m2", "m3"]);
    });

    it("ignores SQL ids that are not in the visible catalogue (e.g. invalid IMDb id rows)", async () => {
      h.searchRows = [{ id: "ghost", rank: 5 }, { id: "m1", rank: 1 }];
      expect(ids(await searchCatalogMovies({ query: "rat" }))).toEqual(["m1"]);
    });

    it("passes the trimmed query as the only bound parameter", async () => {
      await searchCatalogMovies({ query: "  rat race  " });
      const [sql, params] = searchCalls()[0]!;
      expect(params).toEqual(["rat race"]);
      expect(sql).toContain("m.title % $1");
    });

    it("never interpolates the user's text into the SQL", async () => {
      const evil = "x'; DROP TABLE movies; --";
      await searchCatalogMovies({ query: evil });
      const [sql, params] = searchCalls()[0]!;
      expect(sql).not.toContain("DROP TABLE");
      expect(params).toEqual([evil]);
    });

    it("returns [] when SQL finds nothing", async () => {
      expect(await searchCatalogMovies({ query: "zzz" })).toEqual([]);
    });

    it("excludes soft-deleted sightings and movies in both SQL variants", async () => {
      await searchCatalogMovies({ query: "rat" });
      h.trgmFails = true;
      await searchCatalogMovies({ query: "rat" });
      for (const [sql] of searchCalls()) {
        expect(sql).toMatch(/m\.is_deleted = false/);
        expect(sql).toMatch(/s\.is_deleted = false/);
      }
    });
  });

  describe("fallback chain", () => {
    it("pg_trgm missing -> retries with the FTS-only SQL and uses its rows", async () => {
      h.trgmFails = true;
      h.searchRows = [{ id: "m2", rank: 1 }];
      const out = await searchCatalogMovies({ query: "evil" });
      expect(ids(out)).toEqual(["m2"]);
      const calls = searchCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toContain("m.title % $1");
      expect(calls[1]![0]).not.toContain("m.title % $1");
    });

    it("both SQL variants failing -> in-memory substring match on title and summary", async () => {
      h.trgmFails = true;
      h.ftsFails = true;
      h.movieRows[2] = row("m3", "Willard", "tt0368226", { summary: "A boy befriends rats" });
      const out = await searchCatalogMovies({ query: "RATS" });
      expect(ids(out)).toEqual(["m3"]);
      expect(ids(await searchCatalogMovies({ query: "ratatou" }))).toEqual(["m1"]);
    });

    it("in-memory fallback still honours genre and rodent filters", async () => {
      h.trgmFails = true;
      h.ftsFails = true;
      expect(await searchCatalogMovies({ query: "dead", genre: "Comedy" })).toEqual([]);
      expect(await searchCatalogMovies({ query: "dead", rodentMovieIds: new Set(["m1"]) })).toEqual([]);
      expect(ids(await searchCatalogMovies({ query: "dead", rodentMovieIds: new Set(["m2"]) }))).toEqual(["m2"]);
    });

    it("in-memory fallback is a plain substring, not a regex (metacharacters are safe)", async () => {
      h.trgmFails = true;
      h.ftsFails = true;
      expect(await searchCatalogMovies({ query: "(" })).toEqual([]);
      expect(await searchCatalogMovies({ query: ".*" })).toEqual([]);
    });
  });

  it("BUG: LIKE wildcards in the query are not escaped — `imdb_id ilike $1` makes q='%' match every movie", async () => {
    await searchCatalogMovies({ query: "%" });
    const [sql] = searchCalls()[0]!;
    // The raw (unescaped) search string must not be used as an ILIKE pattern.
    expect(sql).not.toMatch(/ilike \$1/i);
  });
});

describe("getCatalogGenres", () => {
  it("returns a de-duplicated, sorted list across movies", async () => {
    h.movieRows = [
      row("a", "A", "tt0000001", { genres: ["Horror", "Comedy"] }),
      row("b", "B", "tt0000002", { genres: ["Comedy", "Animation"] }),
    ];
    expect(await getCatalogGenres()).toEqual(["Animation", "Comedy", "Horror"]);
  });

  it("is empty for an empty catalogue", async () => {
    expect(await getCatalogGenres()).toEqual([]);
  });
});

describe("getCatalogRodentTypes", () => {
  it("lists the known rodent type ids", async () => {
    const types = await getCatalogRodentTypes();
    expect(types).toContain("rat");
    expect(types).toContain("mouse");
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("getCatalogStatsWithCommunity", () => {
  it("returns the counts and rat tally computed by the database", async () => {
    h.stats = { movies: "12", sightings: "40", spoilers: "5", rats: "10017" };
    expect(await getCatalogStatsWithCommunity()).toEqual({
      movies: 12,
      sightings: 40,
      spoilerSightings: 5,
      ratsTallied: 10017,
    });
  });

  it("aggregates in SQL: two queries, no sighting rows pulled into the app", async () => {
    await getCatalogStatsWithCommunity();
    expect(h.query).toHaveBeenCalledTimes(2);
    const sightingsSql = h.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("as rats"))!;
    // Same per-row rule as estimateRatsForAppearance: clamped count, else swarm = 6, else 1.
    expect(sightingsSql).toMatch(/least\(9999, floor\(approximate_rat_count\)\)/);
    expect(sightingsSql).toMatch(/scene_type = 'swarm' then 6/);
    expect(sightingsSql).toMatch(/else 1/);
  });

  it("is all zeros for an empty database", async () => {
    h.noStatsRow = true;
    expect(await getCatalogStatsWithCommunity()).toEqual({
      movies: 0,
      sightings: 0,
      spoilerSightings: 0,
      ratsTallied: 0,
    });
  });

  it("coerces unparseable counts to 0 rather than NaN", async () => {
    h.stats = { movies: "abc", sightings: "", spoilers: "x", rats: "?" };
    const out = await getCatalogStatsWithCommunity();
    expect(out).toEqual({ movies: 0, sightings: 0, spoilerSightings: 0, ratsTallied: 0 });
  });

  it("only counts non-deleted rows in every query", async () => {
    await getCatalogStatsWithCommunity();
    for (const [sql] of h.query.mock.calls) {
      expect(sql).toMatch(/is_deleted = false/);
    }
  });
});

describe("getCatalogListMovies", () => {
  it("maps rows exactly like getCatalogMovies", async () => {
    h.movieRows = [row("m1", "Ratatouille", "tt0382932", { tmdb_id: "2062", poster_url: "" })];
    const [full] = await getCatalogMovies();
    const [list] = await getCatalogListMovies();
    expect(list).toEqual(full);
  });

  it("projects only the list-view metadata keys in SQL, bound as parameters", async () => {
    await getCatalogListMovies();
    const [sql, params] = h.query.mock.calls[0]!;
    expect(sql).toMatch(/jsonb_each\(metadata\)/);
    expect(sql).toMatch(/where is_deleted = false/);
    const [metadataKeys, snapshotKeys] = params as [string[], string[]];
    // Everything the home page, v1 catalog and getMoviePath read:
    expect(metadataKeys).toEqual(
      expect.arrayContaining(["rating", "imdbRating", "imdbVotes", "overrideAccent", "pagePalette", "pagePaletteDark", "syncedPalette", "syncedPaletteDark", "syncedHeaderBannerUrl"]),
    );
    expect(snapshotKeys).toEqual(
      expect.arrayContaining(["Type", "Year", "totalSeasons", "totalEpisodes", "episodeCount"]),
    );
    // ...and never the heavy blobs.
    for (const heavy of ["imdbReviews", "imdbRelated", "imdbImages", "imdbVideos", "cast"]) {
      expect(metadataKeys).not.toContain(heavy);
    }
  });

  it("drops rows without a valid IMDb id", async () => {
    h.movieRows = [row("m1", "Ratatouille", "tt0382932"), row("bad", "Broken", "nope")];
    expect((await getCatalogListMovies()).map((m) => m.id)).toEqual(["m1"]);
  });
});

/** A real mapped Movie (via the fake pool) to hand to functions that accept a caller-supplied list. */
async function loadOneMovie() {
  h.movieRows = [row("m1", "Ratatouille", "tt0382932")];
  return getCatalogMovies();
}

describe("catalog identity lookup", () => {
  it("getCatalogIdentities reads only id/title/imdb and normalises the IMDb id", async () => {
    h.movieRows = [
      { id: "m1", title: "Ratatouille", imdb_id: "https://www.imdb.com/title/TT0382932/" },
      { id: "bad", title: "Broken", imdb_id: "nope" },
    ];
    expect(await getCatalogIdentities()).toEqual([
      { id: "m1", title: "Ratatouille", externalIds: { imdb: "tt0382932" } },
    ]);
    const [sql] = h.query.mock.calls[0]!;
    expect(sql).not.toMatch(/metadata|summary/);
  });

  const movies = [
    { id: "a", title: "Life", externalIds: { imdb: "tt0000001" } },
    { id: "b", title: "  Life  ", externalIds: { imdb: "tt0000002" } },
    { id: "c", title: "Ratatouille", externalIds: { imdb: "tt0382932" } },
  ];
  const lookup = buildCatalogLookup(movies);

  it("an IMDb id is authoritative — no title fallback when it matches nothing", () => {
    expect(resolveMovieForSubmission({ imdbId: "tt0000002", movieTitle: "Ratatouille" }, lookup)?.id).toBe("b");
    expect(resolveMovieForSubmission({ imdbId: "tt9999999", movieTitle: "Ratatouille" }, lookup)).toBeUndefined();
  });

  it("accepts IMDb URLs and mixed case", () => {
    expect(resolveMovieForSubmission({ imdbId: "https://imdb.com/title/TT0382932/", movieTitle: "" }, lookup)?.id).toBe("c");
  });

  it("without an id, matches the title exactly, case- and padding-insensitively, first wins", () => {
    expect(resolveMovieForSubmission({ movieTitle: "  rAtAtOuIlLe " }, lookup)?.id).toBe("c");
    expect(resolveMovieForSubmission({ movieTitle: "life" }, lookup)?.id).toBe("a");
    expect(resolveMovieForSubmission({ movieTitle: "Rat" }, lookup)).toBeUndefined();
  });

  it("a blank title with no id resolves to nothing", () => {
    expect(resolveMovieForSubmission({ imdbId: null, movieTitle: "   " }, lookup)).toBeUndefined();
  });

  it("findCatalogMovieForSubmission reuses a supplied movie list instead of reading the catalog", async () => {
    const supplied = await loadOneMovie();
    h.query.mockClear();
    const found = await findCatalogMovieForSubmission({ imdbId: "tt0382932", movieTitle: "x" }, supplied);
    expect(found?.id).toBe("m1");
    expect(h.query).not.toHaveBeenCalled();
  });

  it("findCatalogMovieForSubmission skips the catalog read when there is nothing to match on", async () => {
    expect(await findCatalogMovieForSubmission({ imdbId: undefined, movieTitle: "  " })).toBeUndefined();
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe("caller-supplied movie lists", () => {
  it("searchCatalogMovies filters the supplied list and does not read the catalog", async () => {
    const supplied = await loadOneMovie();
    h.query.mockClear();
    expect(await searchCatalogMovies({ movies: supplied })).toEqual(supplied);
    expect(await searchCatalogMovies({ movies: supplied, genre: "Horror" })).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("getCatalogGenres derives genres from the supplied list without a query", async () => {
    const mk = (genres: string[]) => ({ genres }) as never;
    expect(await getCatalogGenres([mk(["Drama", "Comedy"]), mk(["Drama"])])).toEqual(["Comedy", "Drama"]);
    expect(h.query).not.toHaveBeenCalled();
  });
});
