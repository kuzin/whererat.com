import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("@/lib/db", () => ({
  getDbPool: () => ({ query: mockQuery }),
}));
vi.mock("@/lib/sighting-edit-store", () => ({
  getSightingOverrides: vi.fn(),
  getDeletedSightingIds: vi.fn(),
}));
// Real lookup/resolution logic; only the DB-backed catalog read is faked.
vi.mock("@/lib/movie-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/movie-catalog")>()),
  findCatalogMovieForSubmission: vi.fn(),
  getCatalogIdentities: vi.fn(),
}));
vi.mock("@/lib/submitter-notify", () => ({ notifySubmitterOfDecision: vi.fn() }));
vi.mock("@/lib/community-movie-store", () => ({ ensureCommunityMovieForSubmission: vi.fn() }));

import { getRodentTypesByMovieId, getMovieIdsWithRodentType } from "@/lib/moderation-store";
import { getSightingOverrides, getDeletedSightingIds } from "@/lib/sighting-edit-store";
import { getCatalogIdentities } from "@/lib/movie-catalog";

const mockGetSightingOverrides = vi.mocked(getSightingOverrides);
const mockGetDeletedSightingIds = vi.mocked(getDeletedSightingIds);
const mockGetCatalogIdentities = vi.mocked(getCatalogIdentities);

type SubmissionRow = {
  id: string;
  status: string;
  imdb_id: string | null;
  movie_title: string;
  rodent_types: string[] | null;
  // NOT NULL columns in the real table; the merge builds a full sighting from them.
  submitted_by: string;
  timestamp_code: string;
  description: string;
  spoiler: boolean;
  approximate_rat_count: number;
  created_at: string;
};

/**
 * readModerationStore() reads submissions and review_actions; getRodentTypesByMovieId
 * reads base sightings. Route each by the table named in the SQL.
 */
function stubDb({
  submissions = [] as SubmissionRow[],
  sightings = [] as Array<{ id: string; movie_id: string; rodent_types: string[] | null }>,
}) {
  mockQuery.mockImplementation((sql: string) => {
    const text = String(sql);
    if (/from\s+sightings/i.test(text)) return Promise.resolve({ rows: sightings });
    if (/from\s+submissions/i.test(text)) return Promise.resolve({ rows: submissions });
    if (/from\s+submission_images/i.test(text)) return Promise.resolve({ rows: [] });
    if (/from\s+review_actions/i.test(text)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

function submission(over: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: "s1",
    status: "approved",
    imdb_id: "tt0000001",
    movie_title: "Movie One",
    rodent_types: ["rat"],
    submitted_by: "Tester",
    timestamp_code: "10%",
    description: "A rat.",
    spoiler: false,
    approximate_rat_count: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSightingOverrides.mockResolvedValue({});
  mockGetDeletedSightingIds.mockResolvedValue(new Set());
  // One catalog movie; submissions with any other IMDb id resolve to nothing.
  mockGetCatalogIdentities.mockResolvedValue([
    { id: "movie-1", title: "Movie One", externalIds: { imdb: "tt0000001" } },
  ]);
});

describe("getRodentTypesByMovieId", () => {
  it("counts approved submissions when the sightings table is empty", async () => {
    // Regression: the browse filter queried `sightings` directly, which is empty in
    // production because every visible sighting is derived from an approved submission.
    stubDb({ submissions: [submission({ rodent_types: ["mouse"] })], sightings: [] });

    const byMovie = await getRodentTypesByMovieId();

    expect(byMovie.get("movie-1")).toEqual(new Set(["mouse"]));
  });

  it("ignores submissions that are not approved", async () => {
    stubDb({ submissions: [submission({ status: "pending" })] });

    expect(await getRodentTypesByMovieId()).toEqual(new Map());
  });

  it("merges base sightings with submission-backed ones", async () => {
    stubDb({
      submissions: [submission({ rodent_types: ["mouse"] })],
      sightings: [{ id: "base-1", movie_id: "movie-1", rodent_types: ["squirrel"] }],
    });

    expect(await getRodentTypesByMovieId()).toEqual(
      new Map([["movie-1", new Set(["squirrel", "mouse"])]]),
    );
  });

  it("treats a sighting with no explicit types as a rat, matching how it renders", async () => {
    stubDb({ submissions: [submission({ rodent_types: null })] });

    expect((await getRodentTypesByMovieId()).get("movie-1")).toEqual(new Set(["rat"]));
  });

  it("applies rodentTypes from sighting overrides", async () => {
    stubDb({ submissions: [submission({ rodent_types: ["rat"] })] });
    mockGetSightingOverrides.mockResolvedValue({ "queue-s1": { rodentTypes: ["beaver"] } });

    expect((await getRodentTypesByMovieId()).get("movie-1")).toEqual(new Set(["beaver"]));
  });

  it("excludes soft-deleted sightings", async () => {
    stubDb({ submissions: [submission()] });
    mockGetDeletedSightingIds.mockResolvedValue(new Set(["queue-s1"]));

    expect(await getRodentTypesByMovieId()).toEqual(new Map());
  });

  it("skips submissions that resolve to no catalog movie", async () => {
    stubDb({ submissions: [submission({ imdb_id: "tt9999999" })] });

    expect(await getRodentTypesByMovieId()).toEqual(new Map());
  });
});

describe("getMovieIdsWithRodentType", () => {
  it("returns only movies carrying that rodent type", async () => {
    stubDb({
      submissions: [
        submission({ id: "s1", rodent_types: ["rat"] }),
        submission({ id: "s2", imdb_id: "tt9999999", rodent_types: ["mouse"] }),
      ],
    });

    expect(await getMovieIdsWithRodentType("rat")).toEqual(new Set(["movie-1"]));
    expect(await getMovieIdsWithRodentType("mouse")).toEqual(new Set());
  });

  it("returns an empty set for a type with no sightings", async () => {
    stubDb({ submissions: [submission()] });

    expect(await getMovieIdsWithRodentType("chipmunk")).toEqual(new Set());
  });
});
