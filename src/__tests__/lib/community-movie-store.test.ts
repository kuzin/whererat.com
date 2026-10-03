/**
 * ensureCommunityMovieForSubmission against an in-memory
 * fake of the `movies` table that enforces the real schema constraints from
 * db/schema.sql (PK, UNIQUE slug, UNIQUE imdb_id — NOT partial on is_deleted —
 * and CHECK release_year > 1800 and < 3000, int4 range). No real DB is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const holder = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock("@/lib/db", () => ({ getDbPool: () => holder.pool }));
vi.mock("@/lib/movie-imdb-sync", () => ({ syncMovieFromImdb: vi.fn() }));

import { ensureCommunityMovieForSubmission } from "@/lib/community-movie-store";
import { syncMovieFromImdb } from "@/lib/movie-imdb-sync";

const mockSync = vi.mocked(syncMovieFromImdb);

class PgError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type Row = {
  id: string;
  slug: string;
  title: string;
  release_year: number;
  runtime_minutes: number;
  genres: string[];
  poster_tone: string;
  poster_url: string;
  backdrop_url: string;
  poster_alt: string;
  imdb_id: string;
  tmdb_id: string | null;
  metadata: Record<string, unknown>;
  summary: string;
  is_deleted: boolean;
};

function movieRow(over: Partial<Row> & Pick<Row, "slug" | "imdb_id">): Row {
  return {
    id: over.id ?? `community-${over.slug}`,
    title: over.title ?? "Existing",
    release_year: 2000,
    runtime_minutes: 100,
    genres: [],
    poster_tone: "bg-stone-700",
    poster_url: "/p.png",
    backdrop_url: "/b.png",
    poster_alt: "alt",
    tmdb_id: null,
    metadata: {},
    summary: "s",
    is_deleted: false,
    ...over,
  };
}

function makeFakePool(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const publicRow = (r: Row) => {
    const { is_deleted: _d, ...rest } = r;
    void _d;
    return rest;
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    await Promise.resolve(); // yield so concurrent callers interleave like real I/O
    const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (s.startsWith("select slug from movies")) {
      return { rows: rows.map((r) => ({ slug: r.slug })) };
    }
    if (s.startsWith("select") && s.includes("from movies")) {
      let out = rows;
      if (s.includes("imdb_id = $1")) out = out.filter((r) => r.imdb_id === params[0]);
      if (s.includes("is_deleted = false")) out = out.filter((r) => !r.is_deleted);
      return { rows: out.map(publicRow) };
    }
    if (s.startsWith("update movies set is_deleted = false")) {
      const hit = rows.find((r) => r.imdb_id === params[0]);
      if (!hit) return { rows: [] };
      hit.is_deleted = false;
      return { rows: [publicRow(hit)] };
    }
    if (s.startsWith("insert into movies")) {
      const [id, slug, title, year, runtime, genres, tone, poster, backdrop, alt, imdb, summary, metadata] =
        params as [string, string, string, number, number, string[], string, string, string, string, string, string, Record<string, unknown>];
      if (typeof year !== "number" || !Number.isInteger(year)) {
        throw new PgError("22P02", `invalid input syntax for type integer: "${String(year)}"`);
      }
      if (year > 2147483647 || year < -2147483648) {
        throw new PgError("22003", "value out of range for type integer");
      }
      if (!(year > 1800 && year < 3000)) {
        throw new PgError("23514", 'new row for relation "movies" violates check constraint "movies_release_year_check"');
      }
      // Postgres checks the ON CONFLICT arbiter (imdb_id) before raising other unique violations.
      if (rows.some((r) => r.imdb_id === imdb)) {
        if (s.includes("on conflict (imdb_id) do nothing")) return { rows: [] };
        throw new PgError("23505", 'duplicate key value violates unique constraint "movies_imdb_id_key"');
      }
      if (rows.some((r) => r.id === id)) throw new PgError("23505", 'duplicate key value violates unique constraint "movies_pkey"');
      if (rows.some((r) => r.slug === slug)) throw new PgError("23505", 'duplicate key value violates unique constraint "movies_slug_key"');
      const row: Row = {
        id, slug, title, release_year: year, runtime_minutes: runtime, genres,
        poster_tone: tone, poster_url: poster, backdrop_url: backdrop, poster_alt: alt,
        imdb_id: imdb, tmdb_id: null, metadata, summary, is_deleted: false,
      };
      rows.push(row);
      return { rows: [publicRow(row)] };
    }
    throw new Error(`unexpected SQL in fake pool: ${s.slice(0, 80)}`);
  });
  return { query, rows, calls, inserts: () => calls.filter((c) => /insert into movies/i.test(c.sql)) };
}

type Fake = ReturnType<typeof makeFakePool>;
let fake: Fake;
function use(initial: Row[] = []) {
  fake = makeFakePool(initial);
  holder.pool = fake;
  return fake;
}

const sub = (over: Record<string, unknown> = {}) => ({
  movieTitle: "Ratatouille",
  movieYear: 2007 as number | undefined,
  imdbId: "tt0382932" as string | undefined,
  moviePosterUrl: "https://image.tmdb.org/t/p/w500/rat.jpg" as string | undefined,
  description: "Remy appears.",
  ...over,
});

beforeEach(() => {
  mockSync.mockReset().mockResolvedValue(undefined as never);
  use();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Identity: IMDb id only
// ─────────────────────────────────────────────────────────────────────────────
describe("ensureCommunityMovieForSubmission: identity", () => {
  it("returns the existing catalog movie matched by IMDb id and inserts nothing", async () => {
    use([movieRow({ slug: "ratatouille-2007", imdb_id: "tt0382932", title: "Ratatouille" })]);
    const movie = await ensureCommunityMovieForSubmission(sub());
    expect(movie?.slug).toBe("ratatouille-2007");
    expect(fake.inserts()).toHaveLength(0);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("matches an IMDb id given as a URL / upper-case", async () => {
    use([movieRow({ slug: "ratatouille-2007", imdb_id: "tt0382932" })]);
    const movie = await ensureCommunityMovieForSubmission(
      sub({ imdbId: "https://www.imdb.com/title/TT0382932/?ref_=x" }),
    );
    expect(movie?.slug).toBe("ratatouille-2007");
    expect(fake.inserts()).toHaveLength(0);
  });

  it("never matches by title: two different films named 'Life' stay separate", async () => {
    use([movieRow({ slug: "life-1999", imdb_id: "tt0000001", title: "Life", release_year: 1999 })]);
    const movie = await ensureCommunityMovieForSubmission(
      sub({ movieTitle: "Life", movieYear: 2017, imdbId: "tt5442430" }),
    );
    expect(movie?.externalIds.imdb).toBe("tt5442430");
    expect(movie?.slug).toBe("life-2017");
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows.map((r) => r.imdb_id).sort()).toEqual(["tt0000001", "tt5442430"]);
  });

  it("title match must also ignore case/whitespace-identical titles with a different IMDb id", async () => {
    use([movieRow({ slug: "life", imdb_id: "tt0000001", title: "  LIFE " })]);
    const movie = await ensureCommunityMovieForSubmission(sub({ movieTitle: "life", imdbId: "tt0000002" }));
    expect(movie?.externalIds.imdb).toBe("tt0000002");
    expect(fake.inserts()).toHaveLength(1);
  });

  it("throws a clear error without an IMDb id and does not touch the DB", async () => {
    for (const imdbId of [undefined, "", "   ", "not-an-id", "tt12"]) {
      await expect(ensureCommunityMovieForSubmission(sub({ imdbId }))).rejects.toThrow(/IMDb title ID/);
    }
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("blank title returns undefined without touching the DB (even with a valid id)", async () => {
    expect(await ensureCommunityMovieForSubmission(sub({ movieTitle: "   " }))).toBeUndefined();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("title is passed as a bound parameter, never interpolated into SQL", async () => {
    const evil = `x'); DROP TABLE movies;--`;
    await ensureCommunityMovieForSubmission(sub({ movieTitle: evil }));
    const [insert] = fake.inserts();
    expect(insert!.sql).not.toContain("DROP TABLE");
    expect(insert!.params).toContain(evil);
    // slug is derived and must be plain
    expect(insert!.params[1]).toMatch(/^[a-z0-9-]+$/);
  });

  it("kicks off an IMDb sync only for newly inserted movies", async () => {
    const movie = await ensureCommunityMovieForSubmission(sub());
    expect(mockSync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: movie!.id }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slugs
// ─────────────────────────────────────────────────────────────────────────────
describe("ensureCommunityMovieForSubmission: slugs", () => {
  it("builds <title>-<year> and uses community-<slug> as the id", async () => {
    const movie = await ensureCommunityMovieForSubmission(sub({ movieTitle: "Willard!", movieYear: 2003 }));
    expect(movie).toMatchObject({ slug: "willard-2003", id: "community-willard-2003" });
  });

  it("bumps -2, -3 on slug collisions between different films", async () => {
    use([
      movieRow({ slug: "life-2017", imdb_id: "tt0000001" }),
      movieRow({ slug: "life-2017-2", imdb_id: "tt0000002" }),
    ]);
    const third = await ensureCommunityMovieForSubmission(sub({ movieTitle: "Life", movieYear: 2017, imdbId: "tt0000003" }));
    expect(third?.slug).toBe("life-2017-3");
    const fourth = await ensureCommunityMovieForSubmission(sub({ movieTitle: "Life", movieYear: 2017, imdbId: "tt0000004" }));
    expect(fourth?.slug).toBe("life-2017-4");
  });

  it("first collision becomes -2", async () => {
    use([movieRow({ slug: "life-2017", imdb_id: "tt0000001" })]);
    const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: "Life", movieYear: 2017, imdbId: "tt0000002" }));
    expect(m?.slug).toBe("life-2017-2");
  });

  it("slugs are lowercase ascii with single dashes for punctuation/accents-free titles", async () => {
    const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: "  Mr. & Mrs. Smith: The Rat!!  ", movieYear: 2005 }));
    expect(m?.slug).toBe("mr-mrs-smith-the-rat-2005");
  });

  it("the title part of the slug is capped at 64 chars", async () => {
    const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: "word ".repeat(100), movieYear: 2005 }));
    expect(m!.slug.length).toBeLessThanOrEqual(64 + "-2005".length);
  });

  it("BUG: a title with no [a-z0-9] characters (e.g. Japanese / Cyrillic / emoji) yields a degenerate slug like '-2019'", async () => {
    // slugBase is always non-empty (`-${year}`), so the `|| submission-<year>` fallback is dead code.
    for (const [i, title] of ["寄生虫", "Паразиты", "🐀🐀", "!!!"].entries()) {
      const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: title, movieYear: 2019, imdbId: `tt100000${i}` }));
      expect(m!.slug, `slug for ${title}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("BUG: truncating a long title at 64 chars can leave a trailing dash and produce a '--' slug", async () => {
    const title = `${"a".repeat(63)} b`; // slug part: 63 a's + "-b" -> sliced to "aaaa…a-"
    const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: title, movieYear: 2005 }));
    expect(m!.slug).not.toMatch(/--/);
  });

  it("BUG: slug uniqueness ignores soft-deleted movies, so a new film can collide with a deleted movie's slug/id and the INSERT throws", async () => {
    // deleteMovieById only sets is_deleted = true; slug/id stay reserved by UNIQUE / PK constraints.
    use([movieRow({ slug: "life-2017", imdb_id: "tt0000001", is_deleted: true })]);
    const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: "Life", movieYear: 2017, imdbId: "tt0000002" }));
    expect(m?.slug).not.toBe("life-2017");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Soft-deleted rows & races
// ─────────────────────────────────────────────────────────────────────────────
describe("ensureCommunityMovieForSubmission: soft-deleted / concurrent", () => {
  it("BUG: approving a submission whose IMDb id belongs to a soft-deleted movie hits movies_imdb_id_key (UNIQUE is not partial) and throws", async () => {
    use([movieRow({ slug: "ratatouille-2007", imdb_id: "tt0382932", title: "Ratatouille", is_deleted: true })]);
    // Correct behaviour: restore/return the deleted row or fail with a deliberate, readable error —
    // not a raw unique-violation from Postgres.
    let err: unknown;
    let movie: unknown;
    try {
      movie = await ensureCommunityMovieForSubmission(sub());
    } catch (e) {
      err = e;
    }
    expect(err instanceof PgError ? err.code : undefined).toBeUndefined();
    void movie;
  });

  it("BUG: check-then-insert is not atomic; two simultaneous approvals for the same IMDb id make the second throw a unique violation", async () => {
    const results = await Promise.allSettled([
      ensureCommunityMovieForSubmission(sub()),
      ensureCommunityMovieForSubmission(sub()),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(fake.rows.filter((r) => r.imdb_id === "tt0382932")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Year handling
// ─────────────────────────────────────────────────────────────────────────────
describe("ensureCommunityMovieForSubmission: release year", () => {
  it("undefined year defaults to the current year", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const m = await ensureCommunityMovieForSubmission(sub({ movieYear: undefined }));
    expect(m?.releaseYear).toBe(2026);
    expect(m?.slug).toBe("ratatouille-2026");
  });

  it.each([
    [NaN, "current"],
    [Infinity, "current"],
    [-Infinity, "current"],
  ])("non-finite year %s falls back to the current year", async (year) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const m = await ensureCommunityMovieForSubmission(sub({ movieYear: year as number }));
    expect(m?.releaseYear).toBe(2026);
  });

  it.each([
    [1801, 1801],
    [2007, 2007],
    [2999, 2999],
    [1999.9, 1999],
    [2007.0001, 2007],
  ])("in-range year %s is stored as %s", async (year, expected) => {
    const m = await ensureCommunityMovieForSubmission(sub({ movieYear: year }));
    expect(m?.releaseYear).toBe(expected);
  });

  // The DB would reject all of these (CHECK release_year > 1800 and < 3000, int4).
  // Correct behaviour: clamp / fall back to a valid year, or throw a deliberate validation error.
  for (const year of [0, -1, 1500, 1800, 3000, 99999, 1e12, 2 ** 31, -(2 ** 40)]) {
    it(`BUG: out-of-range year ${year} is inserted as-is and violates movies.release_year / int4`, async () => {
      let err: unknown;
      let movie: { releaseYear: number } | undefined;
      try {
        movie = await ensureCommunityMovieForSubmission(sub({ movieYear: year }));
      } catch (e) {
        err = e;
      }
      if (err) {
        expect(err instanceof PgError, `raw Postgres error leaked: ${(err as Error).message}`).toBe(false);
      } else {
        expect(movie!.releaseYear).toBeGreaterThan(1800);
        expect(movie!.releaseYear).toBeLessThan(3000);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Poster & description
// ─────────────────────────────────────────────────────────────────────────────
describe("ensureCommunityMovieForSubmission: poster url", () => {
  const FALLBACK = "https://placehold.co/600x900/292524/fef3c7/png?text=Community+Movie";

  it.each([
    undefined,
    "",
    "   ",
    "N/A",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/x.png",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "just-some-text",
    "poster.png",
  ])("non-http poster %j falls back to the placeholder", async (poster) => {
    const m = await ensureCommunityMovieForSubmission(sub({ moviePosterUrl: poster }));
    expect(m?.posterUrl).toBe(FALLBACK);
  });

  it.each([
    ["https://image.tmdb.org/t/p/w500/x.jpg", "https://image.tmdb.org/t/p/w500/x.jpg"],
    ["  https://m.media-amazon.com/images/M/x.jpg  ", "https://m.media-amazon.com/images/M/x.jpg"],
    ["/uploads/posters/x.png", "/uploads/posters/x.png"],
  ])("keeps a sane poster %j", async (poster, expected) => {
    const m = await ensureCommunityMovieForSubmission(sub({ moviePosterUrl: poster }));
    expect(m?.posterUrl).toBe(expected);
  });

  it("BUG: a protocol-relative poster ('//evil.example/x.png') passes the startsWith('/') check", async () => {
    const m = await ensureCommunityMovieForSubmission(sub({ moviePosterUrl: "//evil.example/track.png" }));
    expect(m?.posterUrl).toBe(FALLBACK);
  });

  it("BUG: plain-http and non-allow-listed https hosts are persisted into movies.poster_url (next/image remotePatterns are https + fixed hosts)", async () => {
    for (const [i, url] of ["http://m.media-amazon.com/x.jpg", "https://evil.example/track.png"].entries()) {
      const m = await ensureCommunityMovieForSubmission(sub({ moviePosterUrl: url, imdbId: `tt200000${i}` }));
      expect(m?.posterUrl, url).toBe(FALLBACK);
    }
  });
});

describe("ensureCommunityMovieForSubmission: description / defaults", () => {
  it("uses a default summary when the description is empty or whitespace", async () => {
    for (const [i, description] of ["", "   \n\t "].entries()) {
      const m = await ensureCommunityMovieForSubmission(sub({ description, imdbId: `tt300000${i}` }));
      expect(m?.summary).toBe("Community-submitted movie entry.");
    }
  });

  it("uses the (trimmed) description otherwise", async () => {
    const m = await ensureCommunityMovieForSubmission(sub({ description: "  A rat cooks.  " }));
    expect(m?.summary).toBe("A rat cooks.");
  });

  it("inserts safe placeholder metadata (runtime 1, Uncategorized, Not Rated)", async () => {
    const m = await ensureCommunityMovieForSubmission(sub());
    expect(m).toMatchObject({ runtimeMinutes: 1, genres: ["Uncategorized"] });
    expect(m?.metadata).toMatchObject({ rating: "Not Rated", metadataProvider: "IMDb seed" });
  });

  it("title is trimmed before insert and alt text built from it", async () => {
    const m = await ensureCommunityMovieForSubmission(sub({ movieTitle: "  Ratatouille  " }));
    expect(m?.title).toBe("Ratatouille");
    expect(m?.posterAlt).toBe("Poster for Ratatouille.");
  });

  it("propagates database failures (callers decide how to surface them)", async () => {
    holder.pool = { query: vi.fn().mockRejectedValue(new Error("db down")) };
    await expect(ensureCommunityMovieForSubmission(sub())).rejects.toThrow("db down");
  });
});
