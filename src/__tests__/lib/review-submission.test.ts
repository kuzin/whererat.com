/**
 * reviewSubmission / addSubmission (src/lib/moderation-store.ts) against an
 * in-memory fake of the relevant tables. The fake mirrors the DB constraints
 * that matter here (review_actions.action CHECK, review_actions.note NOT NULL,
 * submissions.approximate_rat_count BETWEEN 1 AND 9999) and deliberately gives
 * snapshot/rollback transaction semantics through `connect()` (BEGIN / COMMIT /
 * ROLLBACK), which is how the production code groups its multi-statement writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ pool: undefined as unknown }));
// Run the REAL @/lib/db (incl. withTransaction) on top of a fake `pg` Pool that
// delegates to the in-memory pool below.
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://fake@localhost/fake";
});
vi.mock("pg", () => ({
  Pool: class {
    query = (...args: unknown[]) => (holder.pool as { query: (...a: unknown[]) => unknown }).query(...args);
    connect = () => (holder.pool as { connect: () => unknown }).connect();
  },
}));
vi.mock("@/lib/community-movie-store", () => ({ ensureCommunityMovieForSubmission: vi.fn() }));
const invalidate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: invalidate }));
vi.mock("@/lib/movie-catalog", () => ({ findCatalogMovieForSubmission: vi.fn() }));
vi.mock("@/lib/submitter-notify", () => ({ notifySubmitterOfDecision: vi.fn() }));
vi.mock("@/lib/sighting-edit-store", () => ({
  getDeletedSightingIds: vi.fn().mockResolvedValue(new Set()),
  getSightingOverrides: vi.fn().mockResolvedValue({}),
}));

import { addSubmission, reviewSubmission } from "@/lib/moderation-store";
import { ensureCommunityMovieForSubmission } from "@/lib/community-movie-store";
import { findCatalogMovieForSubmission } from "@/lib/movie-catalog";
import { notifySubmitterOfDecision } from "@/lib/submitter-notify";

const mockEnsure = vi.mocked(ensureCommunityMovieForSubmission);
const mockFind = vi.mocked(findCatalogMovieForSubmission);
const mockNotify = vi.mocked(notifySubmitterOfDecision);

class PgError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type Img = { url: string; alt: string | null; positionX: number; positionY: number; zoom: number };
type DbSub = Record<string, unknown> & { id: string; status: string };

const moderator = { id: "mod-1", name: "Mo Derator", username: "mod", email: "m@x.io", role: "moderator" } as never;

function baseSubRow(over: Partial<DbSub> = {}): DbSub {
  return {
    id: "sub-1",
    movie_title: "Ratatouille",
    movie_year: 2007,
    imdb_id: "tt0382932",
    imdb_kind: "movie",
    season_number: null,
    episode_number: null,
    episode_title: null,
    timestamp_code: "42%",
    title: "Rat in kitchen",
    description: "Remy appears.",
    spoiler: false,
    approximate_rat_count: 3,
    status: "pending",
    submitted_by: "Alice",
    submitter_email: "alice@example.com",
    curator_note: null,
    duplicate_hint: null,
    movie_poster_url: "https://image.tmdb.org/t/p/old-poster.jpg",
    content_warnings: [],
    rodent_types: ["rat"],
    other_rodent_label: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

type FailHook = (sql: string, params: unknown[], nth: number) => Error | undefined;

function makePool(opts: { sub?: Partial<DbSub>; images?: Img[]; fail?: FailHook } = {}) {
  const state = {
    submission: baseSubRow(opts.sub),
    images: [...(opts.images ?? [])] as Img[],
    reviewActions: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ sql: string; params: unknown[] }>,
    updates: [] as Array<unknown[]>,
  };
  const nthBySql = new Map<string, number>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
    state.calls.push({ sql, params });
    const key = s.slice(0, 40);
    const nth = (nthBySql.get(key) ?? 0) + 1;
    nthBySql.set(key, nth);
    const hookErr = opts.fail?.(s, params, nth);
    if (hookErr) throw hookErr;

    if (s.startsWith("select count(*)")) return { rows: [{ count: "1" }] };
    if (s.includes("from submissions s")) {
      return { rows: [{ ...state.submission, images_json: state.images.length ? state.images : null }] };
    }
    if (s.includes("from review_actions")) return { rows: [] };
    if (s.startsWith("update submissions")) {
      state.updates.push(params);
      const [id, title, year, imdb, kind, season, episode, epTitle, ts, sTitle, desc, spoiler, count, status, by, email, note, hint, poster, cw, rodents, other] = params;
      if (typeof count !== "number" || count < 1 || count > 9999) {
        throw new PgError("23514", "violates check constraint approximate_rat_count");
      }
      if (id !== state.submission.id) return { rows: [] };
      Object.assign(state.submission, {
        movie_title: title, movie_year: year, imdb_id: imdb, imdb_kind: kind, season_number: season,
        episode_number: episode, episode_title: epTitle, timestamp_code: ts, title: sTitle,
        description: desc, spoiler, approximate_rat_count: count, status, submitted_by: by,
        submitter_email: email, curator_note: note, duplicate_hint: hint, movie_poster_url: poster,
        content_warnings: cw, rodent_types: rodents, other_rodent_label: other,
      });
      return { rows: [] };
    }
    if (s.startsWith("delete from submission_images")) {
      state.images = [];
      return { rows: [] };
    }
    if (s.startsWith("insert into submission_images")) {
      const [, url, alt, , px, py, zoom] = params as [string, string, string | null, number, number, number, number];
      state.images.push({ url, alt, positionX: px, positionY: py, zoom });
      return { rows: [] };
    }
    if (s.startsWith("insert into review_actions")) {
      const [id, submissionId, movieTitle, action, moderatorId, moderatorName, reviewedAt, note] = params;
      if (!["approved", "edited", "edited and approved", "merged duplicate", "rejected"].includes(action as string)) {
        throw new PgError("23514", 'new row for relation "review_actions" violates check constraint "review_actions_action_check"');
      }
      if (note === null || note === undefined) {
        throw new PgError("23502", 'null value in column "note" of relation "review_actions" violates not-null constraint');
      }
      state.reviewActions.push({ id, submissionId, movieTitle, action, moderatorId, moderatorName, reviewedAt, note });
      return { rows: [] };
    }
    if (s.startsWith("insert into submissions")) {
      state.submission = baseSubRow({ id: params[0] as string });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL in fake pool: ${s.slice(0, 80)}`);
  });
  // Pooled client with real BEGIN/COMMIT/ROLLBACK semantics: ROLLBACK restores
  // everything the transaction wrote.
  const connect = vi.fn(async () => {
    let snapshot: string | undefined;
    return {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (s === "begin") {
          state.calls.push({ sql, params });
          snapshot = JSON.stringify({
            submission: state.submission,
            images: state.images,
            reviewActions: state.reviewActions,
          });
          return { rows: [] };
        }
        if (s === "commit") {
          state.calls.push({ sql, params });
          snapshot = undefined;
          return { rows: [] };
        }
        if (s === "rollback") {
          state.calls.push({ sql, params });
          if (snapshot) {
            const restored = JSON.parse(snapshot);
            state.submission = restored.submission;
            state.images = restored.images;
            state.reviewActions = restored.reviewActions;
          }
          return { rows: [] };
        }
        return query(sql, params);
      }),
      release: vi.fn(),
    };
  });
  return Object.assign(state, { query, connect });
}

type Pool = ReturnType<typeof makePool>;
let pool: Pool;
function use(opts: Parameters<typeof makePool>[0] = {}) {
  pool = makePool(opts);
  holder.pool = pool;
  return pool;
}

/** Name the positional params of the UPDATE submissions statement. */
function updated(p: Pool = pool) {
  const u = p.updates.at(-1);
  if (!u) return undefined;
  const names = [
    "id", "movieTitle", "movieYear", "imdbId", "imdbKind", "seasonNumber", "episodeNumber", "episodeTitle",
    "timestamp", "title", "description", "spoiler", "approximateRatCount", "status", "submittedBy",
    "submitterEmail", "curatorNote", "duplicateHint", "moviePosterUrl", "contentWarnings", "rodentTypes",
    "otherRodentLabel",
  ];
  return Object.fromEntries(names.map((n, i) => [n, u[i]])) as Record<string, unknown>;
}

const OLD_POSTER = "https://image.tmdb.org/t/p/old-poster.jpg";

beforeEach(() => {
  invalidate.mockReset();
  mockEnsure.mockReset().mockResolvedValue({ id: "community-x" } as never);
  mockFind.mockReset().mockResolvedValue({ id: "movie-1", slug: "ratatouille" } as never);
  mockNotify.mockReset().mockResolvedValue(undefined);
  use();
});

// ─────────────────────────────────────────────────────────────────────────────
// decision -> status / audit action
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: decision mapping", () => {
  it.each([
    ["approved", "approved"],
    ["edited and approved", "approved"],
    ["rejected", "rejected"],
    ["edited", "pending"],
  ] as const)("decision %j sets status %j and logs the same action", async (decision, status) => {
    await reviewSubmission({ submissionId: "sub-1", decision, moderator });
    expect(updated()?.status).toBe(status);
    expect(pool.reviewActions).toHaveLength(1);
    expect(pool.reviewActions[0]).toMatchObject({
      action: decision,
      submissionId: "sub-1",
      moderatorId: "mod-1",
      moderatorName: "Mo Derator",
    });
  });

  it("uses the supplied reason (trimmed) as the audit note, else a decision-specific default", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "rejected", moderator, reason: "  blurry shot  " });
    expect(pool.reviewActions[0]!.note).toBe("blurry shot");
    await reviewSubmission({ submissionId: "sub-1", decision: "rejected", moderator, reason: "   " });
    expect(pool.reviewActions[1]!.note).toBe("Rejected and removed from the pending queue.");
  });

  it("the audit row records the EDITED title, not the stale one", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator, edits: { movieTitle: "Ratatouille (2007)" } });
    expect(pool.reviewActions[0]!.movieTitle).toBe("Ratatouille (2007)");
  });

  it("edits can never override the status chosen by the decision", async () => {
    await reviewSubmission({
      submissionId: "sub-1",
      decision: "edited",
      moderator,
      edits: { status: "approved" } as never,
    });
    expect(updated()?.status).toBe("pending");
  });

  it("BUG: an UNKNOWN decision string (server action casts formData without validating) falls through to status 'approved'", async () => {
    // moderateSubmission() casts String(formData.get('decision')) to the union type; any other
    // value reaches reviewSubmission, whose ternary maps "anything not rejected/edited" to approved.
    await reviewSubmission({ submissionId: "sub-1", decision: "bogus" as never, moderator }).catch(() => undefined);
    expect(pool.updates.every((u) => u[13] !== "approved")).toBe(true);
    expect(pool.submission.status).not.toBe("approved");
  });

  it("BUG: an unknown decision writes the submission as approved, deletes its images, THEN fails on the audit insert (CHECK / NOT NULL) leaving a half-applied review", async () => {
    use({ images: [{ url: "/a.png", alt: null, positionX: 50, positionY: 50, zoom: 1 }] });
    await expect(
      reviewSubmission({ submissionId: "sub-1", decision: "bogus" as never, moderator }),
    ).rejects.toThrow();
    // After the failure nothing should have been applied.
    expect(pool.submission.status).toBe("pending");
    expect(pool.images).toHaveLength(1);
  });

  it("an unknown decision never triggers community-movie creation or a submitter e-mail", async () => {
    mockFind.mockResolvedValue(undefined);
    await reviewSubmission({ submissionId: "sub-1", decision: "bogus" as never, moderator }).catch(() => undefined);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unknown submission
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: unknown submission id", () => {
  it.each(["approved", "edited", "edited and approved", "rejected"] as const)(
    "%j for an unknown id is a silent no-op",
    async (decision) => {
      mockFind.mockResolvedValue(undefined);
      const result = await reviewSubmission({ submissionId: "does-not-exist", decision, moderator });
      expect(result).toBeUndefined();
      expect(pool.updates).toHaveLength(0);
      expect(pool.reviewActions).toHaveLength(0);
      expect(mockEnsure).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
      const writes = pool.calls.filter((c) => /^\s*(update|insert|delete)/i.test(c.sql));
      expect(writes).toHaveLength(0);
    },
  );

  it("an id with SQL metacharacters is only ever a bound value", async () => {
    const evil = "sub-1'; DROP TABLE submissions;--";
    await reviewSubmission({ submissionId: evil, decision: "rejected", moderator });
    expect(pool.calls.every((c) => !c.sql.includes("DROP TABLE"))).toBe(true);
    expect(pool.updates).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// poster handling
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: stale poster", () => {
  it("clears the old poster when the IMDb id changes and no new poster is supplied", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator, edits: { imdbId: "tt1111111" } });
    expect(updated()?.moviePosterUrl).toBeNull();
    expect(updated()?.imdbId).toBe("tt1111111");
  });

  it("keeps a freshly supplied poster when the IMDb id changes", async () => {
    await reviewSubmission({
      submissionId: "sub-1",
      decision: "edited",
      moderator,
      edits: { imdbId: "tt1111111", moviePosterUrl: "https://image.tmdb.org/t/p/new.jpg" },
    });
    expect(updated()?.moviePosterUrl).toBe("https://image.tmdb.org/t/p/new.jpg");
  });

  it("keeps the poster when the IMDb id is unchanged", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator, edits: { imdbId: "tt0382932" } });
    expect(updated()?.moviePosterUrl).toBe(OLD_POSTER);
  });

  it("keeps the poster when the edit does not touch the IMDb id", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator, edits: { movieTitle: "Renamed" } });
    expect(updated()?.moviePosterUrl).toBe(OLD_POSTER);
  });

  it("keeps the poster when there are no edits at all", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator });
    expect(updated()?.moviePosterUrl).toBe(OLD_POSTER);
  });

  it("a stale poster is cleared BEFORE the community movie is created, so it can't leak into movies.poster_url", async () => {
    mockFind.mockResolvedValue(undefined);
    await reviewSubmission({ submissionId: "sub-1", decision: "edited and approved", moderator, edits: { imdbId: "tt1111111" } });
    expect(mockEnsure).toHaveBeenCalledOnce();
    expect(mockEnsure.mock.calls[0]![0]).toMatchObject({ imdbId: "tt1111111", moviePosterUrl: undefined });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// community movie creation
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: ensureCommunityMovieForSubmission", () => {
  it.each(["approved", "edited and approved"] as const)("%j with no catalog movie creates one (once)", async (decision) => {
    mockFind.mockResolvedValue(undefined);
    await reviewSubmission({ submissionId: "sub-1", decision, moderator });
    expect(mockEnsure).toHaveBeenCalledOnce();
  });

  it.each(["approved", "edited and approved"] as const)("%j with an existing catalog movie does NOT create one", async (decision) => {
    mockFind.mockResolvedValue({ id: "movie-1" } as never);
    await reviewSubmission({ submissionId: "sub-1", decision, moderator });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it.each(["edited", "rejected"] as const)("%j never creates a catalog movie, even when none exists", async (decision) => {
    mockFind.mockResolvedValue(undefined);
    await reviewSubmission({ submissionId: "sub-1", decision, moderator });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("looks the movie up using the merged (edited) identity", async () => {
    await reviewSubmission({
      submissionId: "sub-1",
      decision: "edited and approved",
      moderator,
      edits: { movieTitle: "Corrected", imdbId: "tt2222222" },
    });
    expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ movieTitle: "Corrected", imdbId: "tt2222222" }));
  });

  it("if community-movie creation throws, NOTHING is written and no e-mail is sent", async () => {
    mockFind.mockResolvedValue(undefined);
    mockEnsure.mockRejectedValueOnce(new Error("Cannot add a catalog movie without an IMDb title ID"));
    await expect(
      reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator, edits: { imdbId: undefined } }),
    ).rejects.toThrow(/IMDb title ID/);
    expect(pool.updates).toHaveLength(0);
    expect(pool.reviewActions).toHaveLength(0);
    expect(pool.submission.status).toBe("pending");
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rat count clamping
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: approximateRatCount clamping", () => {
  it.each([
    [0, 1],
    [-7, 1],
    [NaN, 1],
    [1, 1],
    [42, 42],
    [9999, 9999],
    [10000, 9999],
    [1e9, 9999],
    [12.8, 12],
    [Infinity, 1],
  ])("count %s is stored as %s", async (input, expected) => {
    await reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator, edits: { approximateRatCount: input } });
    expect(updated()?.approximateRatCount).toBe(expected);
  });

  it("a corrupt stored count is repaired on review (no DB check violation)", async () => {
    use({ sub: { approximate_rat_count: 0 } });
    await reviewSubmission({ submissionId: "sub-1", decision: "rejected", moderator });
    expect(updated()?.approximateRatCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitter notification
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: submitter notification", () => {
  it.each([
    ["approved", "approved"],
    ["edited and approved", "approved"],
    ["rejected", "rejected"],
  ] as const)("%j notifies with %j", async (decision, mail) => {
    await reviewSubmission({ submissionId: "sub-1", decision, moderator });
    expect(mockNotify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "sub-1" }), mail);
  });

  it("'edited' (kept pending) never notifies the submitter", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("the e-mail is built from the reviewed (edited) submission", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator, edits: { title: "New headline" } });
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({ title: "New headline", status: "approved" });
  });

  it("a rejected e-mail promise never fails the review", async () => {
    mockNotify.mockRejectedValueOnce(new Error("smtp down"));
    await expect(reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator })).resolves.toBeUndefined();
  });

  it("no e-mail is sent if a DB write failed", async () => {
    use({ fail: (s) => (s.startsWith("insert into review_actions") ? new Error("db down") : undefined) });
    await expect(reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator })).rejects.toThrow("db down");
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// images + atomicity
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: images and (non-)atomicity", () => {
  const imgs: Img[] = [
    { url: "/a.png", alt: "a", positionX: 10, positionY: 20, zoom: 2 },
    { url: "/b.png", alt: null, positionX: 50, positionY: 50, zoom: 1 },
    { url: "/c.png", alt: "c", positionX: 90, positionY: 5, zoom: 3 },
  ];

  it("re-inserts existing images unchanged and in order when edits don't touch them", async () => {
    use({ images: imgs });
    await reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator });
    expect(pool.images).toEqual(imgs);
  });

  it("edits.images replaces the gallery; an empty array clears it", async () => {
    use({ images: imgs });
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator, edits: { images: [{ url: "/new.png" }] } });
    expect(pool.images).toEqual([{ url: "/new.png", alt: null, positionX: 50, positionY: 50, zoom: 1 }]);
    await reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator, edits: { images: [] } });
    expect(pool.images).toEqual([]);
  });

  it("assigns sort_order by position in the array", async () => {
    use({ images: imgs });
    await reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator });
    const inserts = pool.calls.filter((c) => /insert into submission_images/i.test(c.sql));
    expect(inserts.map((c) => c.params[3])).toEqual([0, 1, 2]);
  });

  it("runs its writes in one transaction (BEGIN … COMMIT on a pooled client)", async () => {
    await reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator });
    const verbs = pool.calls.map((c) => c.sql.trim().toLowerCase()).filter((q) => /^(begin|commit|rollback)$/.test(q));
    expect(verbs).toEqual(["begin", "commit"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("BUG: a failure while re-inserting images deletes the old images and loses the ones not yet re-inserted (no transaction)", async () => {
    use({
      images: imgs,
      fail: (s, _p, nth) => (s.startsWith("insert into submission_images") && nth === 2 ? new Error("connection reset") : undefined),
    });
    await expect(
      reviewSubmission({ submissionId: "sub-1", decision: "edited", moderator }),
    ).rejects.toThrow("connection reset");
    expect(pool.images).toEqual(imgs); // atomic behaviour: either all replaced or none
  });

  it("BUG: a failure writing the review_actions audit row leaves the submission status already changed (no transaction)", async () => {
    use({ fail: (s) => (s.startsWith("insert into review_actions") ? new Error("connection reset") : undefined) });
    await expect(reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator })).rejects.toThrow();
    expect(pool.submission.status).toBe("pending");
  });

  it("untouched user text is only ever bound as parameters", async () => {
    const evil = "'); DELETE FROM submissions;--";
    await reviewSubmission({
      submissionId: "sub-1",
      decision: "edited",
      moderator,
      reason: evil,
      edits: { description: evil, title: evil, curatorNote: evil, images: [{ url: evil, alt: evil }] },
    });
    for (const c of pool.calls) expect(c.sql).not.toContain("DELETE FROM submissions;--");
    expect(pool.reviewActions[0]!.note).toBe(evil);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addSubmission
// ─────────────────────────────────────────────────────────────────────────────
describe("addSubmission", () => {
  const base = {
    movieTitle: "Ratatouille",
    imdbId: "tt0382932",
    timestamp: "42%",
    title: "Rat in kitchen",
    description: "Remy.",
    spoiler: false,
    approximateRatCount: 3,
    submittedBy: "Alice",
  };

  function insertParams() {
    const call = pool.calls.find((c) => /insert into submissions/i.test(c.sql));
    return call?.params;
  }

  it("always creates a pending row with a server-generated id", async () => {
    const row = await addSubmission(base);
    expect(row.status).toBe("pending");
    expect(row.id).toMatch(/^sub-[0-9a-f-]{36}$/);
    expect(insertParams()![13]).toBe("pending");
  });

  it("cannot be coerced into an approved row / forced id via extra properties", async () => {
    const row = await addSubmission({
      ...base,
      status: "approved",
      id: "sub-attacker-chosen",
      submittedAt: new Date(0),
    } as never);
    expect(row.status).toBe("pending");
    expect(row.id).not.toBe("sub-attacker-chosen");
    expect(insertParams()![13]).toBe("pending");
    expect(insertParams()![0]).not.toBe("sub-attacker-chosen");
  });

  it.each([
    [0, 1],
    [-4, 1],
    [NaN, 1],
    [123456, 9999],
  ])("clamps count %s to %s before insert (DB CHECK 1..9999)", async (input, expected) => {
    const row = await addSubmission({ ...base, approximateRatCount: input });
    expect(row.approximateRatCount).toBe(expected);
    expect(insertParams()![12]).toBe(expected);
  });

  it("applies safe defaults for omitted optionals", async () => {
    await addSubmission(base);
    const p = insertParams()!;
    expect(p[2]).toBeNull(); // movie_year
    expect(p[4]).toBe("movie"); // imdb_kind
    expect(p[5]).toBeNull(); // season
    expect(p[6]).toBeNull(); // episode
    expect(p[15]).toBeNull(); // email
    expect(p[19]).toEqual([]); // content_warnings
    expect(p[20]).toEqual(["rat"]); // rodent_types
    expect(p[21]).toBeNull(); // other_rodent_label
  });

  it("inserts images in order with default position/zoom", async () => {
    await addSubmission({ ...base, images: [{ url: "/a.png" }, { url: "/b.png", alt: "b", positionX: 1, positionY: 2, zoom: 3 }] });
    const rows = pool.calls.filter((c) => /insert into submission_images/i.test(c.sql)).map((c) => c.params);
    expect(rows[0]).toEqual([expect.any(String), "/a.png", null, 0, 50, 50, 1]);
    expect(rows[1]).toEqual([expect.any(String), "/b.png", "b", 1, 1, 2, 3]);
  });

  it("SQL metacharacters in any field are bound parameters only", async () => {
    const evil = "x'); DROP TABLE submissions;--";
    await addSubmission({ ...base, movieTitle: evil, description: evil, title: evil, submittedBy: evil });
    for (const c of pool.calls) expect(c.sql).not.toContain("DROP TABLE");
  });

  it("propagates insert failures", async () => {
    use({ fail: (s) => (s.startsWith("insert into submissions") ? new Error("db down") : undefined) });
    await expect(addSubmission(base)).rejects.toThrow("db down");
  });

  it("BUG: if an image insert fails the already-inserted submission row is left behind without its images (no transaction / cleanup)", async () => {
    const inserted: string[] = [];
    use({
      fail: (s, p) => {
        if (s.startsWith("insert into submissions")) inserted.push(p[0] as string);
        return s.startsWith("insert into submission_images") ? new Error("connection reset") : undefined;
      },
    });
    await expect(addSubmission({ ...base, images: [{ url: "/a.png" }] })).rejects.toThrow();
    // The whole insert is one transaction: the failure rolls the submission row back.
    expect(inserted).toHaveLength(1);
    const verbs = pool.calls.map((c) => c.sql.trim().toLowerCase()).filter((q) => /^(begin|commit|rollback)$/.test(q));
    expect(verbs).toEqual(["begin", "rollback"]);
  });

  it("BUG: movie_year, season_number, episode_number are passed straight to int4 columns (no range validation in the store)", async () => {
    // The store is the last line of defence for the API path; an int4 overflow becomes a raw 22003 error.
    use({
      fail: (s, p) =>
        s.startsWith("insert into submissions") && ((p[2] as number) > 2147483647 || (p[5] as number) > 2147483647)
          ? new PgError("22003", "value out of range for type integer")
          : undefined,
    });
    let err: unknown;
    try {
      await addSubmission({ ...base, movieYear: 1e12, seasonNumber: 99999999999, imdbKind: "series", episodeNumber: 1 });
    } catch (e) {
      err = e;
    }
    expect(err instanceof PgError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// catalog cache invalidation
// ─────────────────────────────────────────────────────────────────────────────
describe("reviewSubmission: catalog cache", () => {
  it.each(["approved", "edited and approved", "rejected", "edited"] as const)(
    "expires the catalog cache once the %j decision is committed",
    async (decision) => {
      await reviewSubmission({ submissionId: "sub-1", decision, moderator });
      expect(invalidate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not expire it when the transaction fails (nothing changed)", async () => {
    use({ fail: (sql) => (sql.startsWith("insert into review_actions") ? new PgError("23514", "check") : undefined) });
    await expect(reviewSubmission({ submissionId: "sub-1", decision: "approved", moderator })).rejects.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("filing a new (pending) submission does not touch the public catalog", async () => {
    await addSubmission({
      movieTitle: "Ratatouille", imdbId: "tt0382932", timestamp: "42%", description: "d",
      spoiler: false, approximateRatCount: 1, submittedBy: "Alice",
    } as never);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
