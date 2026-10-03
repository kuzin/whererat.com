import {
  clampApproximateRatCount,
  reviewActions as seedReviewActions,
  submissions as seedSubmissions,
  getSubmissionSightingTitle,
  type Movie,
  type ReviewAction,
  type Sighting,
  type Submission,
} from "@/lib/whererat";
import { notifySubmitterOfDecision } from "@/lib/submitter-notify";
import type { ModeratorSession } from "@/lib/auth";
import { getDeletedSightingIds, getSightingOverrides } from "@/lib/sighting-edit-store";
import {
  ensureCommunityMovieForSubmission,
} from "@/lib/community-movie-store";
import {
  buildCatalogLookup,
  findCatalogMovieForSubmission,
  getCatalogIdentities,
  getCatalogListMovies,
  resolveMovieForSubmission,
} from "@/lib/movie-catalog";
import { getDbPool, withTransaction } from "@/lib/db";
import { invalidateCatalogCache } from "@/lib/catalog-cache";
import { isReviewDecision, type ReviewDecision } from "@/lib/review-decision";
import { parseReleaseYear, parseSeasonOrEpisode } from "@/lib/submission-input";

type SubmissionEdits = Partial<
  Pick<
    Submission,
    | "movieTitle"
    | "movieYear"
    | "imdbId"
    | "title"
    | "imdbKind"
    | "seasonNumber"
    | "episodeNumber"
    | "episodeTitle"
    | "timestamp"
    | "description"
    | "spoiler"
    | "moviePosterUrl"
    | "approximateRatCount"
    | "imageUrl"
    | "imageAlt"
    | "images"
    | "submittedBy"
    | "submitterEmail"
    | "curatorNote"
    | "contentWarnings"
    | "rodentTypes"
    | "otherRodentLabel"
  >
>;

function normalizeSubmission(record: Submission): Submission {
  return {
    ...record,
    approximateRatCount: clampApproximateRatCount(record.approximateRatCount),
  };
}

const STORE_VERSION = 2;
let seededFromFixtures = false;

function toDbSubmission(row: {
  id: string;
  movie_title: string;
  movie_year: number | null;
  imdb_id: string | null;
  imdb_kind: "movie" | "series" | null;
  season_number: number | null;
  episode_number: number | null;
  episode_title: string | null;
  timestamp_code: string;
  title: string | null;
  description: string;
  spoiler: boolean;
  approximate_rat_count: number;
  status: Submission["status"];
  submitted_by: string;
  submitter_email: string | null;
  curator_note: string | null;
  duplicate_hint: string | null;
  movie_poster_url: string | null;
  images_json: unknown;
  content_warnings: string[] | null;
  rodent_types: string[] | null;
  other_rodent_label: string | null;
  created_at: string | Date;
}): Submission {
  const images = Array.isArray(row.images_json)
    ? row.images_json
      .map((slot) => {
        if (!slot || typeof slot !== "object") return undefined;
        const rec = slot as {
          url?: unknown;
          alt?: unknown;
          positionX?: unknown;
          positionY?: unknown;
          zoom?: unknown;
        };
        const url = String(rec.url ?? "").trim();
        if (!url) return undefined;
        const numOr = (v: unknown, fallback: number) => {
          // Number(null) and Number("") are 0, which would silently mean "left/top edge".
          if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return fallback;
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? n : fallback;
        };
        return {
          url,
          alt: rec.alt ? String(rec.alt) : undefined,
          positionX: numOr(rec.positionX, 50),
          positionY: numOr(rec.positionY, 50),
          zoom: numOr(rec.zoom, 1),
        };
      })
      .filter(
        (slot): slot is {
          url: string;
          alt: string | undefined;
          positionX: number;
          positionY: number;
          zoom: number;
        } => Boolean(slot),
      )
    : undefined;
  const leadImage = images?.[0];
  return {
    id: row.id,
    movieTitle: row.movie_title,
    movieYear: row.movie_year ?? undefined,
    imdbId: row.imdb_id ?? undefined,
    imdbKind: row.imdb_kind ?? undefined,
    seasonNumber: row.season_number ?? undefined,
    episodeNumber: row.episode_number ?? undefined,
    episodeTitle: row.episode_title ?? undefined,
    timestamp: row.timestamp_code,
    title: row.title ?? undefined,
    description: row.description,
    spoiler: row.spoiler,
    approximateRatCount: row.approximate_rat_count,
    status: row.status,
    submittedBy: row.submitted_by,
    submitterEmail: row.submitter_email ?? undefined,
    submittedAt: new Date(row.created_at),
    curatorNote: row.curator_note ?? undefined,
    duplicateHint: row.duplicate_hint ?? undefined,
    moviePosterUrl: row.movie_poster_url ?? undefined,
    imageUrl: leadImage?.url,
    imageAlt: leadImage?.alt,
    images,
    contentWarnings: (row.content_warnings?.length ? row.content_warnings : undefined) as string[] | undefined,
    rodentTypes: (row.rodent_types?.length ? row.rodent_types : undefined) as string[] | undefined,
    otherRodentLabel: row.other_rodent_label?.trim() || undefined,
  };
}

function toDbReviewAction(row: {
  id: string;
  submission_id: string;
  movie_title: string;
  action: ReviewAction["action"];
  moderator_id: string;
  moderator_name: string;
  reviewed_at: string;
  note: string;
}): ReviewAction {
  return {
    id: row.id,
    submissionId: row.submission_id,
    movieTitle: row.movie_title,
    action: row.action,
    moderatorId: row.moderator_id,
    moderatorName: row.moderator_name,
    reviewedAt: row.reviewed_at,
    note: row.note,
  };
}

async function ensureSeedModerationStore() {
  if (seededFromFixtures) return;
  const pool = getDbPool();
  const countRes = await pool.query<{ count: string }>(
    "select count(*)::text as count from submissions",
  );
  const existingCount = Number(countRes.rows[0]?.count ?? "0") || 0;
  if (existingCount > 0) {
    seededFromFixtures = true;
    return;
  }
  for (const submission of seedSubmissions) {
    await pool.query(
      `insert into submissions
        (id, movie_title, movie_year, imdb_id, imdb_kind, season_number, episode_number, episode_title, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by, submitter_email, curator_note, duplicate_hint, movie_poster_url)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (id) do nothing`,
      [
        submission.id,
        submission.movieTitle,
        submission.movieYear ?? null,
        submission.imdbId ?? null,
        submission.imdbKind ?? "movie",
        submission.seasonNumber ?? null,
        submission.episodeNumber ?? null,
        submission.episodeTitle ?? null,
        submission.timestamp,
        submission.title ?? null,
        submission.description,
        submission.spoiler,
        clampApproximateRatCount(submission.approximateRatCount),
        submission.status,
        submission.submittedBy,
        submission.submitterEmail ?? null,
        submission.curatorNote ?? null,
        submission.duplicateHint ?? null,
        submission.moviePosterUrl ?? null,
      ],
    );
    for (const [index, slot] of (submission.images ?? []).entries()) {
      await pool.query(
        `insert into submission_images (submission_id, image_url, image_alt, sort_order, image_position_x, image_position_y, image_zoom)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (submission_id, sort_order) do update
           set image_url = excluded.image_url,
               image_alt = excluded.image_alt,
               image_position_x = excluded.image_position_x,
               image_position_y = excluded.image_position_y,
               image_zoom = excluded.image_zoom`,
        [
          submission.id,
          slot.url,
          slot.alt ?? null,
          index,
          slot.positionX ?? 50,
          slot.positionY ?? 50,
          slot.zoom ?? 1,
        ],
      );
    }
  }
  for (const action of seedReviewActions) {
    await pool.query(
      `insert into review_actions
        (id, submission_id, movie_title, action, moderator_id, moderator_name, reviewed_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do nothing`,
      [
        action.id,
        action.submissionId,
        action.movieTitle,
        action.action,
        action.moderatorId,
        action.moderatorName,
        action.reviewedAt,
        action.note,
      ],
    );
  }
  seededFromFixtures = true;
}

type SubmissionQueryRow = Parameters<typeof toDbSubmission>[0];

/** Submission rows with their image carousel folded into `images_json`. */
const SUBMISSIONS_WITH_IMAGES_SQL = `select s.*,
              (
                select json_agg(json_build_object(
                  'url', si.image_url,
                  'alt', si.image_alt,
                  'positionX', si.image_position_x,
                  'positionY', si.image_position_y,
                  'zoom', si.image_zoom
                ) order by si.sort_order)
                from submission_images si
                where si.submission_id = s.id
              ) as images_json
       from submissions s`;

export async function readModerationStore() {
  await ensureSeedModerationStore();
  const pool = getDbPool();
  const [submissionRows, reviewRows] = await Promise.all([
    pool.query<SubmissionQueryRow>(`${SUBMISSIONS_WITH_IMAGES_SQL}
       order by s.id asc`),
    pool.query<{
      id: string;
      submission_id: string;
      movie_title: string;
      action: ReviewAction["action"];
      moderator_id: string;
      moderator_name: string;
      reviewed_at: string;
      note: string;
    }>(
      `select id, submission_id, movie_title, action, moderator_id, moderator_name, reviewed_at, note
       from review_actions
       order by reviewed_at desc`,
    ),
  ]);
  return {
    version: STORE_VERSION,
    submissions: submissionRows.rows.map(toDbSubmission).map(normalizeSubmission),
    reviewActions: reviewRows.rows.map(toDbReviewAction),
  };
}

const APPROVAL_ACTIONS: ReadonlySet<ReviewAction["action"]> = new Set([
  "approved",
  "edited and approved",
]);

/**
 * Just what the public views need from the queue: approved submissions (with images) and
 * when each was last approved. Skips the pending/rejected backlog and the full audit log
 * that `readModerationStore` loads for the moderation screen.
 */
async function readApprovedSubmissions(): Promise<{
  submissions: Submission[];
  approvedAt: Map<string, string>;
}> {
  await ensureSeedModerationStore();
  const pool = getDbPool();
  const [submissionRows, reviewRows] = await Promise.all([
    pool.query<SubmissionQueryRow>(`${SUBMISSIONS_WITH_IMAGES_SQL}
       where s.status = 'approved'
       order by s.id asc`),
    pool.query<{
      submission_id: string;
      action: ReviewAction["action"];
      reviewed_at: string;
    }>(
      `select submission_id, action, reviewed_at
       from review_actions
       where action = any($1::text[])`,
      [[...APPROVAL_ACTIONS]],
    ),
  ]);
  const approvedAt = new Map<string, string>();
  for (const row of reviewRows.rows) {
    if (!APPROVAL_ACTIONS.has(row.action)) continue;
    const current = approvedAt.get(row.submission_id);
    if (current === undefined || new Date(row.reviewed_at).getTime() > new Date(current).getTime()) {
      approvedAt.set(row.submission_id, row.reviewed_at);
    }
  }
  return {
    submissions: submissionRows.rows
      .map(toDbSubmission)
      .map(normalizeSubmission)
      .filter((submission) => submission.status === "approved"),
    approvedAt,
  };
}

/** Sum `approximateRatCount` across moderator-approved submissions in the queue store */
export async function getApprovedSubmissionRatTally(): Promise<number> {
  await ensureSeedModerationStore();
  const result = await getDbPool().query<{ total: string | null }>(
    `select coalesce(sum(approximate_rat_count), 0)::text as total
     from submissions
     where status = 'approved'`,
  );
  return Number(result.rows[0]?.total ?? "0") || 0;
}

export async function addSubmission(
  submission: Omit<Submission, "id" | "status" | "submittedAt">,
) {
  await ensureSeedModerationStore();
  const nextSubmission: Submission = {
    ...submission,
    // Out-of-range numbers would surface as raw Postgres errors (int4 / check constraints).
    movieYear:
      submission.movieYear === undefined ? undefined : parseReleaseYear(String(submission.movieYear)),
    seasonNumber:
      submission.seasonNumber === undefined ? undefined : parseSeasonOrEpisode(String(submission.seasonNumber)),
    episodeNumber:
      submission.episodeNumber === undefined ? undefined : parseSeasonOrEpisode(String(submission.episodeNumber)),
    id: `sub-${crypto.randomUUID()}`,
    status: "pending",
    submittedAt: new Date(),
    approximateRatCount: clampApproximateRatCount(submission.approximateRatCount),
  };
  await withTransaction(async (client) => {
    await client.query(
      `insert into submissions
        (id, movie_title, movie_year, imdb_id, imdb_kind, season_number, episode_number, episode_title, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by, submitter_email, curator_note, duplicate_hint, movie_poster_url, content_warnings, rodent_types, other_rodent_label)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        nextSubmission.id,
        nextSubmission.movieTitle,
        nextSubmission.movieYear ?? null,
        nextSubmission.imdbId ?? null,
        nextSubmission.imdbKind ?? "movie",
        nextSubmission.seasonNumber ?? null,
        nextSubmission.episodeNumber ?? null,
        nextSubmission.episodeTitle ?? null,
        nextSubmission.timestamp,
        nextSubmission.title ?? null,
        nextSubmission.description,
        nextSubmission.spoiler,
        nextSubmission.approximateRatCount,
        nextSubmission.status,
        nextSubmission.submittedBy,
        nextSubmission.submitterEmail ?? null,
        nextSubmission.curatorNote ?? null,
        nextSubmission.duplicateHint ?? null,
        nextSubmission.moviePosterUrl ?? null,
        nextSubmission.contentWarnings ?? [],
        nextSubmission.rodentTypes ?? ["rat"],
        nextSubmission.otherRodentLabel ?? null,
      ],
    );
    for (const [index, slot] of (nextSubmission.images ?? []).entries()) {
      await client.query(
        `insert into submission_images (submission_id, image_url, image_alt, sort_order, image_position_x, image_position_y, image_zoom)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          nextSubmission.id,
          slot.url,
          slot.alt ?? null,
          index,
          slot.positionX ?? 50,
          slot.positionY ?? 50,
          slot.zoom ?? 1,
        ],
      );
    }
  });

  return nextSubmission;
}

type BaseSightingRow = {
  id: string;
  movie_id: string;
  timestamp_code: string;
  title: string | null;
  description: string;
  prominence: Sighting["prominence"];
  scene_type: Sighting["sceneType"];
  spoiler: boolean;
  confidence: Sighting["confidence"];
  verification_state: Sighting["verificationState"];
  verified_by: string;
  source_ids: string[];
  curator_note: string | null;
  approximate_rat_count: number | null;
  submitter_name: string | null;
  submission_reviewed_at: string | null;
  content_warnings: string[] | null;
  rodent_types: string[] | null;
  other_rodent_label: string | null;
};

function toBaseSighting(row: BaseSightingRow): Sighting {
  return {
    id: row.id,
    movieId: row.movie_id,
    timestamp: row.timestamp_code,
    title: row.title ?? undefined,
    description: row.description,
    prominence: row.prominence,
    sceneType: row.scene_type,
    spoiler: row.spoiler,
    confidence: row.confidence,
    verificationState: row.verification_state,
    verifiedBy: row.verified_by,
    sourceIds: row.source_ids,
    curatorNote: row.curator_note ?? undefined,
    approximateRatCount: row.approximate_rat_count ?? undefined,
    submitterName: row.submitter_name ?? undefined,
    submissionReviewedAtISO: row.submission_reviewed_at ?? undefined,
    contentWarnings: (row.content_warnings?.length ? row.content_warnings : undefined),
    rodentTypes: (row.rodent_types?.length ? row.rodent_types : undefined),
    otherRodentLabel: row.other_rodent_label?.trim() || undefined,
  };
}

function toSyntheticSighting(
  submission: Submission,
  movieId: string,
  reviewedAtISO: string,
): Sighting {
  const name = submission.submittedBy.trim();
  const headline = getSubmissionSightingTitle(submission);
  return {
    id: `queue-${submission.id}`,
    movieId,
    timestamp: submission.timestamp,
    title: headline,
    description: submission.description,
    prominence: "background",
    sceneType: "live-action",
    spoiler: submission.spoiler,
    confidence: "verified",
    verificationState: "verified",
    verifiedBy: name || "Community",
    sourceIds: [],
    approximateRatCount: submission.approximateRatCount,
    images: submission.images,
    imageUrl: submission.imageUrl,
    imageAlt: submission.imageAlt,
    submitterName: name || undefined,
    curatorNote: submission.curatorNote,
    submissionReviewedAtISO: reviewedAtISO,
    imdbKind: submission.imdbKind,
    seasonNumber: submission.seasonNumber,
    episodeNumber: submission.episodeNumber,
    episodeTitle: submission.episodeTitle,
    contentWarnings: submission.contentWarnings,
    rodentTypes: submission.rodentTypes,
    otherRodentLabel: submission.otherRodentLabel,
  };
}

/**
 * Everything the public sighting views are built from, read once: base `sightings` rows,
 * approved queue submissions (+ approval times), per-sighting overrides, soft-deleted ids,
 * and a catalog index to resolve each submission to its movie.
 *
 * Pass `movieId` to read base rows for just that movie (the submissions are still all
 * needed, to find which ones resolve to it).
 */
async function loadSightingSources(movieId?: string) {
  const pool = getDbPool();
  const [approved, baseRows, overrides, deleted, identities] = await Promise.all([
    readApprovedSubmissions(),
    movieId === undefined
      ? pool.query<BaseSightingRow>(`select * from sightings where is_deleted = false`)
      : pool.query<BaseSightingRow>(
          `select *
           from sightings
           where movie_id = $1 and is_deleted = false`,
          [movieId],
        ),
    getSightingOverrides(),
    getDeletedSightingIds(),
    getCatalogIdentities(),
  ]);
  return {
    approved,
    base: baseRows.rows.map(toBaseSighting),
    overrides,
    deleted,
    lookup: buildCatalogLookup(identities),
  };
}

type SightingSources = Awaited<ReturnType<typeof loadSightingSources>>;

/**
 * Static catalog sightings plus approved-queue rows resolved to catalog movies (by IMDb id
 * or title), with overrides applied and soft-deleted rows removed — grouped by movie.
 * Per movie, base sightings come first, then queue sightings in submission-id order.
 */
function mergeSightings(
  { approved, base, overrides, deleted, lookup }: SightingSources,
  onlyMovieId?: string,
): Map<string, Sighting[]> {
  const byMovie = new Map<string, Sighting[]>();
  const add = (sighting: Sighting) => {
    if (deleted.has(sighting.id)) return;
    const list = byMovie.get(sighting.movieId) ?? [];
    list.push({ ...sighting, ...(overrides[sighting.id] ?? {}) });
    byMovie.set(sighting.movieId, list);
  };

  for (const sighting of base) {
    if (onlyMovieId === undefined || sighting.movieId === onlyMovieId) add(sighting);
  }
  for (const submission of approved.submissions) {
    const movie = resolveMovieForSubmission(submission, lookup);
    if (!movie || (onlyMovieId !== undefined && movie.id !== onlyMovieId)) continue;
    const reviewedAt = approved.approvedAt.get(submission.id) ?? new Date(0).toISOString();
    add(toSyntheticSighting(submission, movie.id, reviewedAt));
  }
  return byMovie;
}

/**
 * Effective rodent types per movie, over the same merged view the movie pages
 * render: base `sightings` rows plus approved submissions, with sighting
 * overrides applied and deleted sightings removed.
 *
 * The browse filter used to query `sightings` directly. That table is empty in
 * production — every visible sighting is a synthetic one derived from an
 * approved submission — so the filter matched nothing for every rodent type.
 */
export async function getRodentTypesByMovieId(): Promise<Map<string, Set<string>>> {
  return rodentTypesFromMerged(await getMergedSightingsByMovie());
}

/** Rodent types per movie, derived from already-merged sightings. */
export function rodentTypesFromMerged(
  merged: ReadonlyMap<string, readonly Sighting[]>,
): Map<string, Set<string>> {
  const byMovie = new Map<string, Set<string>>();
  for (const [movieId, sightings] of merged) {
    const set = new Set<string>();
    for (const sighting of sightings) {
      // Sightings with no explicit types render as rats, so match the "rat" filter.
      const types = sighting.rodentTypes?.length ? sighting.rodentTypes : ["rat"];
      for (const type of types) set.add(type);
    }
    if (set.size > 0) byMovie.set(movieId, set);
  }
  return byMovie;
}

/** Movie ids with at least one visible sighting of the given rodent type. */
export async function getMovieIdsWithRodentType(rodentType: string): Promise<Set<string>> {
  const byMovie = await getRodentTypesByMovieId();
  const ids = new Set<string>();
  for (const [movieId, types] of byMovie) {
    if (types.has(rodentType)) ids.add(movieId);
  }
  return ids;
}

/** Visible sightings for every movie in one pass (6 queries total, however many movies). */
export async function getMergedSightingsByMovie(): Promise<Map<string, Sighting[]>> {
  return mergeSightings(await loadSightingSources());
}

export async function getMergedSightingsForMovie(movieId: string): Promise<Sighting[]> {
  return mergeSightings(await loadSightingSources(movieId), movieId).get(movieId) ?? [];
}

export type CatalogSighting = { sighting: Sighting; movie: Movie };

/**
 * Every visible sighting paired with the movie it is filed under, in catalog order — the
 * same merged view the movie pages render, for moderation screens that span the catalog.
 * `movie` comes from {@link getCatalogListMovies}: list fields only, not full metadata.
 */
export async function getAllMergedSightings(): Promise<CatalogSighting[]> {
  const [byMovie, movies] = await Promise.all([getMergedSightingsByMovie(), getCatalogListMovies()]);
  return movies.flatMap((movie) =>
    (byMovie.get(movie.id) ?? []).map((sighting) => ({ sighting, movie })),
  );
}

export type ReviewResult =
  | { applied: true }
  | { applied: false; reason: "not-found" | "stale"; currentStatus?: Submission["status"] };

/**
 * Applies a moderator's decision.
 *
 * `expectedStatus` is the status the moderator was looking at when they clicked (a page
 * can be stale: another tab, another moderator, a double click). If the submission is
 * no longer in that status nothing is written, emailed or logged and `applied: false` is
 * returned. The check is repeated under a row lock inside the transaction, so two
 * simultaneous clicks can't both win. Callers that omit it get the old unguarded behaviour.
 */
export async function reviewSubmission({
  submissionId,
  decision,
  moderator,
  reason,
  edits,
  expectedStatus,
}: {
  submissionId: string;
  decision: ReviewDecision;
  moderator: ModeratorSession;
  reason?: string;
  edits?: SubmissionEdits;
  expectedStatus?: Submission["status"] | Submission["status"][];
}): Promise<ReviewResult> {
  // Anything else would fall through to "approved" below and then fail the audit-log
  // insert, leaving an approved submission with no catalog movie.
  if (!isReviewDecision(decision)) {
    throw new Error(`Unknown review decision: ${String(decision).slice(0, 40)}`);
  }

  const state = await readModerationStore();
  const submission = state.submissions.find((item) => item.id === submissionId);

  if (!submission) {
    return { applied: false, reason: "not-found" };
  }

  const allowedStatuses = expectedStatus === undefined ? undefined : [expectedStatus].flat();
  if (allowedStatuses && !allowedStatuses.includes(submission.status)) {
    return { applied: false, reason: "stale", currentStatus: submission.status };
  }

  const status: Submission["status"] =
    decision === "rejected"
      ? "rejected"
      : decision === "edited"
        ? "pending"
        : "approved";
  const reviewedAt = new Date().toISOString();
  const defaultNoteByDecision: Record<ReviewDecision, string> = {
    approved: "Approved and promoted out of the pending queue.",
    edited: "Edited in moderation and kept in pending queue.",
    "edited and approved": "Edited by a moderator, then approved.",
    rejected: "Rejected and removed from the pending queue.",
  };
  const reviewNote = reason?.trim() || defaultNoteByDecision[decision];
  const merged: Submission = {
    ...submission,
    ...edits,
    status,
  };
  // The old poster belongs to the old title; moving to another IMDb id must not keep it.
  if (edits?.imdbId && edits.imdbId !== submission.imdbId && !edits.moviePosterUrl) {
    merged.moviePosterUrl = undefined;
  }
  const reviewedSubmission: Submission = {
    ...merged,
    approximateRatCount: clampApproximateRatCount(merged.approximateRatCount),
  };

  const existingCatalogMovie = await findCatalogMovieForSubmission(reviewedSubmission);
  if (
    (decision === "approved" || decision === "edited and approved") &&
    !existingCatalogMovie
  ) {
    await ensureCommunityMovieForSubmission(reviewedSubmission);
  }

  const nextReviewAction: ReviewAction = {
    id: `review-${crypto.randomUUID()}`,
    submissionId,
    movieTitle: reviewedSubmission.movieTitle,
    action: decision,
    moderatorId: moderator.id,
    moderatorName: moderator.name,
    reviewedAt,
    note: reviewNote,
  };

  let lostRace = false;
  let staleStatus: Submission["status"] | undefined;
  await withTransaction(async (client) => {
    if (allowedStatuses) {
      // Authoritative re-check under a row lock: a concurrent decision commits first and
      // this one then sees the new status and does nothing.
      const locked = await client.query<{ status: Submission["status"] }>(
        `select status from submissions where id = $1 for update`,
        [submissionId],
      );
      const current = locked.rows[0]?.status;
      if (!current || !allowedStatuses.includes(current)) {
        lostRace = true;
        staleStatus = current;
        return;
      }
    }
    await client.query(
      `update submissions
          set movie_title = $2,
              movie_year = $3,
              imdb_id = $4,
              imdb_kind = $5,
              season_number = $6,
              episode_number = $7,
              episode_title = $8,
              timestamp_code = $9,
              title = $10,
              description = $11,
              spoiler = $12,
              approximate_rat_count = $13,
              status = $14,
              submitted_by = $15,
              submitter_email = $16,
              curator_note = $17,
              duplicate_hint = $18,
              movie_poster_url = $19,
              content_warnings = $20,
              rodent_types = $21,
              other_rodent_label = $22,
              updated_at = now()
        where id = $1`,
      [
        reviewedSubmission.id,
        reviewedSubmission.movieTitle,
        reviewedSubmission.movieYear ?? null,
        reviewedSubmission.imdbId ?? null,
        reviewedSubmission.imdbKind ?? "movie",
        reviewedSubmission.seasonNumber ?? null,
        reviewedSubmission.episodeNumber ?? null,
        reviewedSubmission.episodeTitle ?? null,
        reviewedSubmission.timestamp,
        reviewedSubmission.title ?? null,
        reviewedSubmission.description,
        reviewedSubmission.spoiler,
        reviewedSubmission.approximateRatCount,
        reviewedSubmission.status,
        reviewedSubmission.submittedBy,
        reviewedSubmission.submitterEmail ?? null,
        reviewedSubmission.curatorNote ?? null,
        reviewedSubmission.duplicateHint ?? null,
        reviewedSubmission.moviePosterUrl ?? null,
        reviewedSubmission.contentWarnings ?? [],
        reviewedSubmission.rodentTypes ?? ["rat"],
        reviewedSubmission.otherRodentLabel ?? null,
      ],
    );
    await client.query(
      `delete from submission_images where submission_id = $1`,
      [reviewedSubmission.id],
    );
    for (const [index, slot] of (reviewedSubmission.images ?? []).entries()) {
      await client.query(
        `insert into submission_images (submission_id, image_url, image_alt, sort_order, image_position_x, image_position_y, image_zoom)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          reviewedSubmission.id,
          slot.url,
          slot.alt ?? null,
          index,
          slot.positionX ?? 50,
          slot.positionY ?? 50,
          slot.zoom ?? 1,
        ],
      );
    }
    await client.query(
      `insert into review_actions
        (id, submission_id, movie_title, action, moderator_id, moderator_name, reviewed_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        nextReviewAction.id,
        nextReviewAction.submissionId,
        nextReviewAction.movieTitle,
        nextReviewAction.action,
        nextReviewAction.moderatorId,
        nextReviewAction.moderatorName,
        nextReviewAction.reviewedAt,
        nextReviewAction.note,
      ],
    );
  });

  if (lostRace) {
    return { applied: false, reason: staleStatus ? "stale" : "not-found", currentStatus: staleStatus };
  }

  // Approvals add/change public sightings and counts; rejections/edits can remove or alter them.
  invalidateCatalogCache();

  if (decision === "approved" || decision === "edited and approved" || decision === "rejected") {
    const emailDecision = decision === "rejected" ? "rejected" : "approved";
    notifySubmitterOfDecision(reviewedSubmission, emailDecision).catch(() => {});
  }
  return { applied: true };
}

export async function deleteSubmissionById(submissionId: string) {
  const pool = getDbPool();
  await pool.query(`delete from submissions where id = $1`, [submissionId]);
  invalidateCatalogCache();
}
