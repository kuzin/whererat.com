/**
 * Read-side of moderation-store.ts: readModerationStore (row mapping + one-time
 * fixture seeding), getApprovedSubmissionRatTally, getMergedSightingsForMovie
 * (base rows + approved queue, overrides, soft deletes) and deleteSubmissionById.
 * Write paths (reviewSubmission / addSubmission) live in review-submission.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  overrides: {} as Record<string, Record<string, unknown>>,
  deleted: new Set<string>(),
  find: vi.fn(),
  invalidate: vi.fn(),
  /** Catalog movies (id/title/imdb) that approved submissions can resolve to. */
  identities: [] as Array<{ id: string; title: string; externalIds: { imdb: string } }>,
  seedSubs: [] as unknown[],
  seedActions: [] as unknown[],
}));

vi.mock("@/lib/whererat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whererat")>();
  return { ...actual, submissions: h.seedSubs, reviewActions: h.seedActions };
});

vi.mock("@/lib/db", () => ({
  getDbPool: () => ({ query: h.query }),
  withTransaction: vi.fn(),
}));
vi.mock("@/lib/sighting-edit-store", () => ({
  getSightingOverrides: vi.fn(async () => h.overrides),
  getDeletedSightingIds: vi.fn(async () => h.deleted),
}));
// Real lookup/resolution logic; only the DB-backed catalog read is faked.
vi.mock("@/lib/movie-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/movie-catalog")>();
  return {
    ...actual,
    findCatalogMovieForSubmission: h.find,
    getCatalogIdentities: vi.fn(async () => h.identities),
  };
});
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: h.invalidate }));
vi.mock("@/lib/submitter-notify", () => ({ notifySubmitterOfDecision: vi.fn() }));
vi.mock("@/lib/community-movie-store", () => ({ ensureCommunityMovieForSubmission: vi.fn() }));

type Row = Record<string, unknown>;
const state = {
  count: "5",
  submissions: [] as Row[],
  reviews: [] as Row[],
  baseSightings: [] as Row[],
};

function subRow(id: string, over: Row = {}): Row {
  return {
    id,
    movie_title: "Ratatouille",
    movie_year: 2007,
    imdb_id: "tt0382932",
    imdb_kind: "movie",
    season_number: null,
    episode_number: null,
    episode_title: null,
    timestamp_code: "42%",
    title: "Remy in the kitchen",
    description: "Remy appears.",
    spoiler: false,
    approximate_rat_count: 3,
    status: "approved",
    submitted_by: "Alice",
    submitter_email: "alice@example.com",
    curator_note: null,
    duplicate_hint: null,
    movie_poster_url: null,
    images_json: null,
    content_warnings: null,
    rodent_types: null,
    other_rodent_label: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function baseRow(id: string, movieId: string, over: Row = {}): Row {
  return {
    id,
    movie_id: movieId,
    timestamp_code: "10%",
    title: null,
    description: "d",
    prominence: "featured",
    scene_type: "live-action",
    spoiler: false,
    confidence: "high",
    verification_state: "verified",
    verified_by: "Mod",
    source_ids: ["s1"],
    curator_note: null,
    approximate_rat_count: null,
    submitter_name: null,
    submission_reviewed_at: null,
    content_warnings: null,
    rodent_types: null,
    other_rodent_label: null,
    ...over,
  };
}

function route(sql: string, params?: unknown[]) {
  const text = String(sql);
  if (/select count\(\*\)/i.test(text)) return { rows: [{ count: state.count }] };
  if (/sum\(approximate_rat_count\)/i.test(text)) {
    // Emulates the SQL: only approved rows are summed.
    const total = state.submissions
      .filter((r) => r.status === "approved")
      .reduce((sum, r) => sum + Number(r.approximate_rat_count), 0);
    return { rows: [{ total: String(total) }] };
  }
  if (/^\s*insert into/i.test(text)) return { rows: [], rowCount: 1 };
  if (/from\s+submissions\s+s\b/i.test(text)) return { rows: state.submissions };
  if (/from\s+review_actions/i.test(text)) return { rows: state.reviews };
  if (/from\s+sightings/i.test(text)) {
    // `where movie_id = $1` for one movie; no parameter means every movie's rows.
    const movieId = params?.[0];
    return {
      rows: movieId === undefined ? state.baseSightings : state.baseSightings.filter((r) => r.movie_id === movieId),
    };
  }
  if (/delete from submissions/i.test(text)) return { rows: [], rowCount: 1 };
  throw new Error(`unexpected sql: ${text}`);
}

async function load() {
  vi.resetModules();
  return await import("@/lib/moderation-store");
}

beforeEach(() => {
  state.count = "5";
  state.submissions = [];
  state.reviews = [];
  state.baseSightings = [];
  h.overrides = {};
  h.deleted = new Set();
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string, params?: unknown[]) => route(sql, params));
  h.find.mockReset();
  h.find.mockResolvedValue(undefined);
  h.invalidate.mockReset();
  h.identities = [];
  h.seedSubs.length = 0;
  h.seedActions.length = 0;
  h.seedSubs.push({
    id: "seed-1",
    movieTitle: "Seed Movie",
    timestamp: "1%",
    description: "seeded",
    spoiler: false,
    approximateRatCount: 123456,
    status: "approved",
    submittedBy: "Seeder",
    submittedAt: new Date(),
    images: [{ url: "/seed.png" }, { url: "/seed2.png", alt: "a", positionX: 1, positionY: 2, zoom: 3 }],
  });
  h.seedActions.push({
    id: "seed-r1",
    submissionId: "seed-1",
    movieTitle: "Seed Movie",
    action: "approved",
    moderatorId: "m",
    moderatorName: "M",
    reviewedAt: "2026-01-01T00:00:00.000Z",
    note: "n",
  });
});

describe("readModerationStore — fixture seeding", () => {
  it("seeds fixtures exactly once when the submissions table is empty", async () => {
    state.count = "0";
    const store = await load();
    await store.readModerationStore();
    const inserts = h.query.mock.calls.filter(([sql]) => /^\s*insert into/i.test(String(sql)));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.some(([sql]) => /insert into submissions/i.test(String(sql)))).toBe(true);
    expect(inserts.every(([sql]) => /on conflict/i.test(String(sql)))).toBe(true);
    expect(inserts.some(([sql]) => /insert into submission_images/i.test(String(sql)))).toBe(true);
    expect(inserts.some(([sql]) => /insert into review_actions/i.test(String(sql)))).toBe(true);

    h.query.mockClear();
    await store.readModerationStore();
    expect(h.query.mock.calls.some(([sql]) => /count\(\*\)/i.test(String(sql)))).toBe(false);
    expect(h.query.mock.calls.some(([sql]) => /^\s*insert into/i.test(String(sql)))).toBe(false);
  });

  it("does not seed when rows already exist, and remembers that", async () => {
    state.count = "3";
    const store = await load();
    await store.readModerationStore();
    expect(h.query.mock.calls.some(([sql]) => /^\s*insert into/i.test(String(sql)))).toBe(false);
    h.query.mockClear();
    await store.readModerationStore();
    expect(h.query.mock.calls.some(([sql]) => /count\(\*\)/i.test(String(sql)))).toBe(false);
  });

  it("a non-numeric count is treated as empty (seeds)", async () => {
    state.count = "oops";
    const store = await load();
    await store.readModerationStore();
    expect(h.query.mock.calls.some(([sql]) => /insert into submissions/i.test(String(sql)))).toBe(true);
  });

  it("seed inserts are parameterised and clamp rat counts to the DB range", async () => {
    state.count = "0";
    const store = await load();
    await store.readModerationStore();
    let seen = false;
    for (const [sql, params] of h.query.mock.calls) {
      if (/insert into submissions/i.test(String(sql))) {
        const count = (params as unknown[])[12] as number;
        expect(count).toBe(9999);
        seen = true;
      }
    }
    expect(seen).toBe(true);
  });
});

describe("readModerationStore — mapping", () => {
  it("maps rows into Submissions and review actions", async () => {
    state.submissions = [
      subRow("sub-1", {
        movie_year: null,
        imdb_id: null,
        imdb_kind: "series",
        season_number: 2,
        episode_number: 5,
        episode_title: "Pilot",
        submitter_email: null,
        curator_note: "note",
        movie_poster_url: "https://x/p.jpg",
        created_at: "2026-02-03T04:05:06.000Z",
      }),
    ];
    state.reviews = [
      {
        id: "r1",
        submission_id: "sub-1",
        movie_title: "Ratatouille",
        action: "approved",
        moderator_id: "m1",
        moderator_name: "Mo",
        reviewed_at: "2026-02-04T00:00:00.000Z",
        note: "ok",
      },
    ];
    const store = await load();
    const out = await store.readModerationStore();
    expect(out.version).toBe(2);
    expect(out.submissions[0]).toMatchObject({
      id: "sub-1",
      movieTitle: "Ratatouille",
      movieYear: undefined,
      imdbId: undefined,
      imdbKind: "series",
      seasonNumber: 2,
      episodeNumber: 5,
      episodeTitle: "Pilot",
      timestamp: "42%",
      submitterEmail: undefined,
      curatorNote: "note",
      moviePosterUrl: "https://x/p.jpg",
      submittedAt: new Date("2026-02-03T04:05:06.000Z"),
      status: "approved",
    });
    expect(out.reviewActions).toEqual([
      {
        id: "r1",
        submissionId: "sub-1",
        movieTitle: "Ratatouille",
        action: "approved",
        moderatorId: "m1",
        moderatorName: "Mo",
        reviewedAt: "2026-02-04T00:00:00.000Z",
        note: "ok",
      },
    ]);
  });

  it("clamps approximate rat counts into 1..9999", async () => {
    state.submissions = [
      subRow("a", { approximate_rat_count: 0 }),
      subRow("b", { approximate_rat_count: 123456 }),
      subRow("c", { approximate_rat_count: 7 }),
    ];
    const store = await load();
    const counts = (await store.readModerationStore()).submissions.map((s) => s.approximateRatCount);
    expect(counts).toEqual([1, 9999, 7]);
  });

  it("normalises empty arrays / blank labels to undefined", async () => {
    state.submissions = [
      subRow("a", { content_warnings: [], rodent_types: [], other_rodent_label: "   " }),
      subRow("b", { content_warnings: ["gore"], rodent_types: ["mouse"], other_rodent_label: " Capybara " }),
    ];
    const store = await load();
    const [a, b] = (await store.readModerationStore()).submissions;
    expect(a).toMatchObject({ contentWarnings: undefined, rodentTypes: undefined, otherRodentLabel: undefined });
    expect(b).toMatchObject({ contentWarnings: ["gore"], rodentTypes: ["mouse"], otherRodentLabel: "Capybara" });
  });

  describe("image slots", () => {
    it("parses images, derives the lead image, and fills numeric defaults", async () => {
      state.submissions = [
        subRow("a", {
          images_json: [
            { url: " /a.png ", alt: "first", positionX: 10, positionY: "20", zoom: 2 },
            { url: "/b.png", alt: null, positionX: undefined, positionY: "abc", zoom: undefined },
          ],
        }),
      ];
      const store = await load();
      const [s] = (await store.readModerationStore()).submissions;
      expect(s!.imageUrl).toBe("/a.png");
      expect(s!.imageAlt).toBe("first");
      expect(s!.images).toEqual([
        { url: "/a.png", alt: "first", positionX: 10, positionY: 20, zoom: 2 },
        { url: "/b.png", alt: undefined, positionX: 50, positionY: 50, zoom: 1 },
      ]);
    });

    // numOr() runs Number(v): null and "" become 0, not the documented default of 50.
    // Unreachable today (image_position_* are NOT NULL DEFAULT 50) but a latent trap.
    it("BUG(latent): null / blank position values map to 0 (left/top edge) instead of the 50 default", async () => {
      state.submissions = [
        subRow("a", { images_json: [{ url: "/a.png", positionX: null, positionY: "", zoom: null }] }),
      ];
      const store = await load();
      const [slot] = (await store.readModerationStore()).submissions[0]!.images!;
      expect(slot).toMatchObject({ positionX: 50, positionY: 50, zoom: 1 });
    });

    it("drops junk slots (null, non-objects, blank urls) without throwing", async () => {
      state.submissions = [
        subRow("a", { images_json: [null, "str", 5, { url: "" }, { url: "   " }, {}, { url: "/ok.png" }] }),
      ];
      const store = await load();
      const [s] = (await store.readModerationStore()).submissions;
      expect(s!.images).toEqual([{ url: "/ok.png", alt: undefined, positionX: 50, positionY: 50, zoom: 1 }]);
    });

    it("null / non-array images_json yields undefined images and no lead image", async () => {
      state.submissions = [subRow("a", { images_json: null }), subRow("b", { images_json: { url: "/x" } })];
      const store = await load();
      for (const s of (await store.readModerationStore()).submissions) {
        expect(s.images).toBeUndefined();
        expect(s.imageUrl).toBeUndefined();
      }
    });

    it("an empty images array yields an empty list and no lead image", async () => {
      state.submissions = [subRow("a", { images_json: [] })];
      const store = await load();
      const [s] = (await store.readModerationStore()).submissions;
      expect(s!.images).toEqual([]);
      expect(s!.imageUrl).toBeUndefined();
    });
  });

  it("propagates DB failures", async () => {
    h.query.mockRejectedValue(new Error("db down"));
    const store = await load();
    await expect(store.readModerationStore()).rejects.toThrow("db down");
  });
});

describe("getApprovedSubmissionRatTally", () => {
  it("sums counts of approved submissions only", async () => {
    state.submissions = [
      subRow("a", { status: "approved", approximate_rat_count: 3 }),
      subRow("b", { status: "approved", approximate_rat_count: 4 }),
      subRow("c", { status: "pending", approximate_rat_count: 100 }),
      subRow("d", { status: "rejected", approximate_rat_count: 100 }),
    ];
    const store = await load();
    expect(await store.getApprovedSubmissionRatTally()).toBe(7);
  });

  it("is 0 with no submissions", async () => {
    const store = await load();
    expect(await store.getApprovedSubmissionRatTally()).toBe(0);
  });

  it("sums in SQL over approved rows only, without loading submissions", async () => {
    const store = await load();
    await store.getApprovedSubmissionRatTally();
    const [sql] = h.query.mock.calls.at(-1)!;
    expect(String(sql)).toMatch(/sum\(approximate_rat_count\)/);
    expect(String(sql)).toMatch(/where status = 'approved'/);
    expect(h.query.mock.calls.some(([q]) => /json_agg|submission_images/i.test(String(q)))).toBe(false);
  });
});

describe("getMergedSightingsForMovie", () => {
  /** Makes the default submission (tt0382932 / "Ratatouille") resolve to catalog movie `id`. */
  const resolvesTo = (id: string) => {
    h.identities = [{ id, title: "Ratatouille", externalIds: { imdb: "tt0382932" } }];
  };

  it("maps base sighting rows, only for the requested movie, with a parameterised query", async () => {
    state.baseSightings = [
      baseRow("s1", "m1", { title: "T", curator_note: "cn", approximate_rat_count: 4, submitter_name: "Bob", other_rodent_label: " Vole " }),
      baseRow("s2", "m2"),
    ];
    const store = await load();
    const out = await store.getMergedSightingsForMovie("m1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "s1",
      movieId: "m1",
      timestamp: "10%",
      title: "T",
      curatorNote: "cn",
      approximateRatCount: 4,
      submitterName: "Bob",
      otherRodentLabel: "Vole",
      sourceIds: ["s1"],
    });
    const call = h.query.mock.calls.find(([sql]) => /from\s+sightings/i.test(String(sql)))!;
    expect(call[1]).toEqual(["m1"]);
    expect(String(call[0])).toMatch(/is_deleted = false/);
  });

  it("nulls become undefined; empty arrays become undefined", async () => {
    state.baseSightings = [baseRow("s1", "m1", { content_warnings: [], rodent_types: [] })];
    const store = await load();
    const [s] = await store.getMergedSightingsForMovie("m1");
    expect(s).toMatchObject({
      title: undefined,
      curatorNote: undefined,
      approximateRatCount: undefined,
      submitterName: undefined,
      submissionReviewedAtISO: undefined,
      contentWarnings: undefined,
      rodentTypes: undefined,
      otherRodentLabel: undefined,
    });
  });

  it("returns [] for a movie with nothing", async () => {
    const store = await load();
    expect(await store.getMergedSightingsForMovie("m1")).toEqual([]);
  });

  it("merges approved submissions that resolve to this movie as synthetic 'queue-' sightings", async () => {
    state.submissions = [
      subRow("sub-1", {
        title: "Remy",
        submitted_by: "  Alice  ",
        spoiler: true,
        approximate_rat_count: 5,
        rodent_types: ["rat"],
        images_json: [{ url: "/i.png", alt: "alt", positionX: 1, positionY: 2, zoom: 3 }],
      }),
    ];
    state.reviews = [
      { id: "r1", submission_id: "sub-1", movie_title: "x", action: "approved", moderator_id: "m", moderator_name: "M", reviewed_at: "2026-03-01T00:00:00.000Z", note: "" },
      { id: "r2", submission_id: "sub-1", movie_title: "x", action: "edited and approved", moderator_id: "m", moderator_name: "M", reviewed_at: "2026-04-01T00:00:00.000Z", note: "" },
      { id: "r3", submission_id: "sub-1", movie_title: "x", action: "edited", moderator_id: "m", moderator_name: "M", reviewed_at: "2026-05-01T00:00:00.000Z", note: "" },
      { id: "r4", submission_id: "other", movie_title: "x", action: "approved", moderator_id: "m", moderator_name: "M", reviewed_at: "2026-06-01T00:00:00.000Z", note: "" },
    ];
    resolvesTo("m1");
    const store = await load();
    const out = await store.getMergedSightingsForMovie("m1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "queue-sub-1",
      movieId: "m1",
      title: "Remy",
      verifiedBy: "Alice",
      submitterName: "Alice",
      spoiler: true,
      approximateRatCount: 5,
      confidence: "verified",
      verificationState: "verified",
      prominence: "background",
      imageUrl: "/i.png",
      submissionReviewedAtISO: "2026-04-01T00:00:00.000Z",
    });
  });

  it("uses the epoch as review time when no approval action is on record", async () => {
    state.submissions = [subRow("sub-1")];
    resolvesTo("m1");
    const store = await load();
    const [s] = await store.getMergedSightingsForMovie("m1");
    expect(s!.submissionReviewedAtISO).toBe(new Date(0).toISOString());
  });

  it("anonymous submitters show as 'Community' with no submitter name", async () => {
    state.submissions = [subRow("sub-1", { submitted_by: "   " })];
    resolvesTo("m1");
    const store = await load();
    const [s] = await store.getMergedSightingsForMovie("m1");
    expect(s).toMatchObject({ verifiedBy: "Community", submitterName: undefined });
  });

  it("ignores pending and rejected submissions", async () => {
    state.submissions = [subRow("p", { status: "pending" }), subRow("r", { status: "rejected" })];
    resolvesTo("m1");
    const store = await load();
    expect(await store.getMergedSightingsForMovie("m1")).toEqual([]);
    // The read itself is restricted to approved rows, not just filtered afterwards.
    const call = h.query.mock.calls.find(([sql]) => /from\s+submissions\s+s\b/i.test(String(sql)))!;
    expect(String(call[0])).toMatch(/where s\.status = 'approved'/);
  });

  it("does not attach an approved submission that resolves to a different movie", async () => {
    state.submissions = [subRow("sub-1")];
    resolvesTo("other-movie");
    const store = await load();
    expect(await store.getMergedSightingsForMovie("m1")).toEqual([]);
  });

  it("does not attach an approved submission that resolves to no movie", async () => {
    state.submissions = [subRow("sub-1")];
    h.identities = [];
    const store = await load();
    expect(await store.getMergedSightingsForMovie("m1")).toEqual([]);
  });

  it("removes soft-deleted base and queue sightings", async () => {
    state.baseSightings = [baseRow("s1", "m1"), baseRow("s2", "m1")];
    state.submissions = [subRow("sub-1")];
    resolvesTo("m1");
    h.deleted = new Set(["s1", "queue-sub-1"]);
    const store = await load();
    const out = await store.getMergedSightingsForMovie("m1");
    expect(out.map((s) => s.id)).toEqual(["s2"]);
  });

  it("applies per-sighting overrides over base and queue sightings", async () => {
    state.baseSightings = [baseRow("s1", "m1", { description: "orig" })];
    state.submissions = [subRow("sub-1")];
    resolvesTo("m1");
    h.overrides = {
      s1: { description: "edited", spoiler: true },
      "queue-sub-1": { title: "Edited title" },
      unrelated: { description: "nope" },
    };
    const store = await load();
    const out = await store.getMergedSightingsForMovie("m1");
    const byId = Object.fromEntries(out.map((s) => [s.id, s]));
    expect(byId["s1"]).toMatchObject({ description: "edited", spoiler: true, timestamp: "10%" });
    expect(byId["queue-sub-1"]).toMatchObject({ title: "Edited title" });
    expect(out).toHaveLength(2);
  });

  it("lists base sightings before queue sightings", async () => {
    state.baseSightings = [baseRow("s1", "m1")];
    state.submissions = [subRow("sub-1")];
    resolvesTo("m1");
    const store = await load();
    expect((await store.getMergedSightingsForMovie("m1")).map((s) => s.id)).toEqual(["s1", "queue-sub-1"]);
  });
});

describe("getMergedSightingsByMovie (bulk)", () => {
  const identity = (id: string, imdb: string) => ({ id, title: `Movie ${id}`, externalIds: { imdb } });
  const sqlCalls = () => h.query.mock.calls.map(([sql]) => String(sql));

  it("groups base and queue sightings by movie, base first, in one pass", async () => {
    state.baseSightings = [baseRow("s1", "m1"), baseRow("s2", "m2"), baseRow("s3", "m1")];
    state.submissions = [
      subRow("sub-a", { imdb_id: "tt0000001" }),
      subRow("sub-b", { imdb_id: "tt0000002" }),
      subRow("sub-c", { imdb_id: "tt0000001" }),
    ];
    h.identities = [identity("m1", "tt0000001"), identity("m2", "tt0000002")];

    const store = await load();
    const byMovie = await store.getMergedSightingsByMovie();

    expect([...byMovie.keys()].sort()).toEqual(["m1", "m2"]);
    expect(byMovie.get("m1")!.map((s) => s.id)).toEqual(["s1", "s3", "queue-sub-a", "queue-sub-c"]);
    expect(byMovie.get("m2")!.map((s) => s.id)).toEqual(["s2", "queue-sub-b"]);
  });

  it("issues the same handful of queries however many movies and submissions there are", async () => {
    state.baseSightings = Array.from({ length: 30 }, (_, i) => baseRow(`s${i}`, `m${i}`));
    state.submissions = Array.from({ length: 30 }, (_, i) => subRow(`sub-${i}`, { imdb_id: `tt${1000000 + i}` }));
    h.identities = Array.from({ length: 30 }, (_, i) => identity(`m${i}`, `tt${1000000 + i}`));

    const store = await load();
    await store.getMergedSightingsByMovie(); // warm: the one-time fixture-seeding check
    h.query.mockClear();
    await store.getMergedSightingsByMovie();
    const many = h.query.mock.calls.length;

    h.query.mockClear();
    state.baseSightings = state.baseSightings.slice(0, 3);
    state.submissions = state.submissions.slice(0, 3);
    await store.getMergedSightingsByMovie();
    expect(h.query.mock.calls.length).toBe(many);
  });

  it("reads all base sightings with no movie parameter (one query, not one per movie)", async () => {
    const store = await load();
    await store.getMergedSightingsByMovie();
    const sightingsCalls = h.query.mock.calls.filter(([sql]) => /from\s+sightings/i.test(String(sql)));
    expect(sightingsCalls).toHaveLength(1);
    expect(sightingsCalls[0]![1] ?? []).toEqual([]);
  });

  it("matches the single-movie read for every movie", async () => {
    state.baseSightings = [baseRow("s1", "m1"), baseRow("s2", "m2")];
    state.submissions = [subRow("sub-a", { imdb_id: "tt0000002" })];
    h.identities = [identity("m1", "tt0000001"), identity("m2", "tt0000002")];
    h.overrides = { s1: { description: "edited" } };
    h.deleted = new Set(["s2"]);

    const store = await load();
    const bulk = await store.getMergedSightingsByMovie();
    for (const id of ["m1", "m2"]) {
      expect(bulk.get(id) ?? []).toEqual(await store.getMergedSightingsForMovie(id));
    }
  });

  it("omits movies whose every sighting was deleted", async () => {
    state.baseSightings = [baseRow("s1", "m1")];
    h.deleted = new Set(["s1"]);
    const store = await load();
    expect((await store.getMergedSightingsByMovie()).has("m1")).toBe(false);
  });

  it("an approved submission resolving to several equal titles attaches to the first catalog match only", async () => {
    state.submissions = [subRow("sub-a", { imdb_id: null, movie_title: "  the LIFE " })];
    h.identities = [
      { id: "first", title: "The Life", externalIds: { imdb: "tt0000001" } },
      { id: "second", title: "The Life", externalIds: { imdb: "tt0000002" } },
    ];
    const store = await load();
    const byMovie = await store.getMergedSightingsByMovie();
    expect([...byMovie.keys()]).toEqual(["first"]);
  });

  it("reads only approved submissions and their approval actions, not the whole audit log", async () => {
    const store = await load();
    await store.getMergedSightingsByMovie();
    const sub = sqlCalls().find((sql) => /from\s+submissions\s+s\b/i.test(sql))!;
    const review = sqlCalls().find((sql) => /from\s+review_actions/i.test(sql))!;
    expect(sub).toMatch(/where s\.status = 'approved'/);
    expect(review).toMatch(/where action = any\(\$1::text\[\]\)/);
    const reviewParams = h.query.mock.calls.find(([sql]) => /from\s+review_actions/i.test(String(sql)))![1];
    expect(reviewParams).toEqual([["approved", "edited and approved"]]);
  });

  it("the review time is the LATEST approval, whatever order the rows come back in", async () => {
    state.submissions = [subRow("sub-1")];
    state.reviews = [
      { id: "r1", submission_id: "sub-1", action: "edited and approved", reviewed_at: "2026-04-01T00:00:00.000Z" },
      { id: "r2", submission_id: "sub-1", action: "approved", reviewed_at: "2026-03-01T00:00:00.000Z" },
      { id: "r3", submission_id: "sub-1", action: "edited", reviewed_at: "2030-01-01T00:00:00.000Z" },
    ];
    h.identities = [identity("m1", "tt0382932")];
    const store = await load();
    const [s] = (await store.getMergedSightingsByMovie()).get("m1")!;
    expect(s!.submissionReviewedAtISO).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("rodentTypesFromMerged", () => {
  it("collects types per movie, treating untyped sightings as rats", async () => {
    const store = await load();
    const merged = new Map([
      ["m1", [{ rodentTypes: ["mouse"] }, { rodentTypes: undefined }, { rodentTypes: [] }] as never],
      ["m2", [{ rodentTypes: ["beaver", "rat"] }] as never],
      ["m3", [] as never],
    ]);
    const out = store.rodentTypesFromMerged(merged);
    expect(out.get("m1")).toEqual(new Set(["mouse", "rat"]));
    expect(out.get("m2")).toEqual(new Set(["beaver", "rat"]));
    expect(out.has("m3")).toBe(false);
  });
});

describe("catalog cache invalidation", () => {
  it("deleting a submission expires the catalog cache", async () => {
    const store = await load();
    await store.deleteSubmissionById("sub-1");
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("merely reading never invalidates", async () => {
    const store = await load();
    await store.getMergedSightingsByMovie();
    await store.getMergedSightingsForMovie("m1");
    await store.getApprovedSubmissionRatTally();
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

describe("deleteSubmissionById", () => {
  it("deletes by id with a bound parameter", async () => {
    const store = await load();
    await store.deleteSubmissionById("sub-1' OR '1'='1");
    const [sql, params] = h.query.mock.calls.at(-1)!;
    expect(String(sql)).toMatch(/delete from submissions where id = \$1/i);
    expect(params).toEqual(["sub-1' OR '1'='1"]);
  });

  it("is a no-op for unknown ids (no throw)", async () => {
    h.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = await load();
    await expect(store.deleteSubmissionById("nope")).resolves.toBeUndefined();
  });
});
