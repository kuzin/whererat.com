/**
 * Adversarial tests for the public sighting submit path
 * (`executePublicSightingSubmit`). Every dependency that could touch a DB, the
 * network or the disk is mocked.
 *
 * Tests assert the CORRECT / SAFE behaviour. Where production code does not
 * (yet) behave safely the test is written as `it.fails("BUG: ...")`: it passes
 * while the defect exists and flips red the day somebody fixes it, at which
 * point the `.fails` should simply be removed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/moderation-store", () => ({
  addSubmission: vi.fn(),
  reviewSubmission: vi.fn(),
}));
vi.mock("@/lib/movie-catalog", () => ({
  findCatalogMovieForSubmission: vi.fn(),
}));
vi.mock("@/lib/media-storage", () => ({
  persistSightingFiles: vi.fn(),
  parseSightingImageGalleryForm: vi.fn(),
  SIGHTING_GALLERY_FIELD_NAMES: {
    file: "sightingImageFile",
    url: "sightingImageUrl",
    alt: "sightingImageAlt",
    positionX: "sightingImagePositionX",
    positionY: "sightingImagePositionY",
    zoom: "sightingImageZoom",
  },
  SIGHTING_GALLERY_SENTINEL: "sightingImageListManaged",
}));
vi.mock("@/lib/moderation-notify", () => ({
  notifyOwnerOfNewSubmission: vi.fn(),
}));
vi.mock("@/lib/submitter-notify", () => ({
  notifySubmitterOfReceipt: vi.fn(),
}));
vi.mock("@/lib/email-preferences-store", () => ({
  upsertMarketingOptIn: vi.fn(),
}));

import { executePublicSightingSubmit } from "@/lib/public-sighting-submit";
import { addSubmission } from "@/lib/moderation-store";
import { findCatalogMovieForSubmission } from "@/lib/movie-catalog";
import { persistSightingFiles, parseSightingImageGalleryForm } from "@/lib/media-storage";
import { notifyOwnerOfNewSubmission } from "@/lib/moderation-notify";
import { notifySubmitterOfReceipt } from "@/lib/submitter-notify";
import { upsertMarketingOptIn } from "@/lib/email-preferences-store";
import { MAX_OTHER_RODENT_LABEL_LENGTH, RODENT_TYPE_OPTIONS } from "@/lib/whererat";

const mockAdd = vi.mocked(addSubmission);
const mockFind = vi.mocked(findCatalogMovieForSubmission);
const mockPersist = vi.mocked(persistSightingFiles);
const mockGallery = vi.mocked(parseSightingImageGalleryForm);
const mockNotifyOwner = vi.mocked(notifyOwnerOfNewSubmission);
const mockNotifySubmitter = vi.mocked(notifySubmitterOfReceipt);
const mockOptIn = vi.mocked(upsertMarketingOptIn);

let ipCounter = 0;
/** Unique IP per call so the module-level rate-limit map never interferes. */
const nextIp = () => `adv-${++ipCounter}-${Math.random().toString(36).slice(2)}`;

type Overrides = Record<string, string | undefined>;

function makeForm(overrides: Overrides = {}): FormData {
  const fd = new FormData();
  fd.set("movieTitle", "Ratatouille");
  fd.set("imdbId", "tt0382932");
  fd.set("sightingTitle", "Rat in kitchen");
  fd.set("timestamp", "42%");
  fd.set("description", "Remy appears on the counter.");
  fd.set("submitterName", "Alice");
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

async function submit(overrides: Overrides = {}, ip = nextIp()) {
  const result = await executePublicSightingSubmit(makeForm(overrides), ip);
  return result;
}

function lastAddArg() {
  const call = mockAdd.mock.calls.at(-1);
  if (!call) throw new Error("addSubmission was not called");
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockReset().mockResolvedValue({ id: "sub-1" } as never);
  mockFind.mockReset().mockResolvedValue(undefined);
  mockPersist.mockReset().mockResolvedValue([]);
  mockGallery.mockReset().mockResolvedValue([]);
  mockNotifyOwner.mockReset().mockResolvedValue(undefined);
  mockNotifySubmitter.mockReset().mockResolvedValue(undefined);
  mockOptIn.mockReset().mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required fields
// ─────────────────────────────────────────────────────────────────────────────
describe("required fields: whitespace / invisible input", () => {
  const WS = " \t\r\n     ";
  for (const field of [
    "movieTitle",
    "sightingTitle",
    "timestamp",
    "description",
    "submitterName",
  ]) {
    it(`whitespace-only ${field} is rejected as missing and nothing is written`, async () => {
      const r = await submit({ [field]: WS });
      expect(r).toMatchObject({ ok: false, code: "missing" });
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it(`absent ${field} is rejected as missing`, async () => {
      const r = await submit({ [field]: undefined });
      expect(r).toMatchObject({ ok: false, code: "missing" });
      expect(mockAdd).not.toHaveBeenCalled();
    });
  }

  it("whitespace-only imdbId is rejected as no-imdb", async () => {
    const r = await submit({ imdbId: WS });
    expect(r).toMatchObject({ ok: false, code: "no-imdb" });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("surrounding whitespace is trimmed from accepted fields", async () => {
    await submit({
      movieTitle: "  Ratatouille \n",
      sightingTitle: "\tRat in kitchen  ",
      description: "  desc  ",
      submitterName: "  Alice ",
    });
    expect(lastAddArg()).toMatchObject({
      movieTitle: "Ratatouille",
      title: "Rat in kitchen",
      description: "desc",
      submittedBy: "Alice",
    });
  });

  it(
    "BUG: zero-width-only / invisible-only text passes the required-field check",
    async () => {
      // U+200B ZERO WIDTH SPACE is not stripped by String#trim(); the submission
      // is accepted with a visually blank title / description / name.
      for (const field of ["sightingTitle", "description", "submitterName", "movieTitle"]) {
        mockAdd.mockClear();
        const r = await submit({ [field]: "​​​" });
        expect(r.ok, `${field} of only zero-width spaces must be rejected`).toBe(false);
        expect(mockAdd).not.toHaveBeenCalled();
      }
    },
  );

  it("BUG: a File part sent in a text field is coerced to the string '[object File]'", async () => {
    const fd = makeForm();
    fd.set("description", new File(["x"], "x.txt", { type: "text/plain" }));
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r.ok).toBe(false);
  });

  it("rodentTypes=other without a label is rejected before anything is written", async () => {
    const fd = makeForm();
    fd.append("rodentTypes", "other");
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r).toMatchObject({ ok: false, code: "missing" });
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IMDb id extraction
// ─────────────────────────────────────────────────────────────────────────────
describe("imdbId normalisation through the submit path", () => {
  it.each([
    ["https://www.imdb.com/title/tt0382932/", "tt0382932"],
    ["https://m.imdb.com/title/tt0382932/?ref_=fn_al_tt_1", "tt0382932"],
    ["TT0382932", "tt0382932"],
    ["  tt0382932  ", "tt0382932"],
    ["see tt0382932 for details", "tt0382932"],
    ["tt0382932'; DROP TABLE movies;--", "tt0382932"],
  ])("%j -> %j", async (input, expected) => {
    const r = await submit({ imdbId: input });
    expect(r.ok).toBe(true);
    expect(lastAddArg().imdbId).toBe(expected);
    // The movie lookup must use the normalised id, never raw user text.
    expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ imdbId: expected }));
  });

  it.each(["nope", "tt123", "tt", "12345678", "ttabcdefg", "imdb.com/title/", "t t0382932"])(
    "rejects %j as no-imdb",
    async (input) => {
      const r = await submit({ imdbId: input });
      expect(r).toMatchObject({ ok: false, code: "no-imdb" });
      expect(mockAdd).not.toHaveBeenCalled();
    },
  );

  it("BUG: an over-long 'tt' number is silently truncated into a different, valid-looking id", async () => {
    // 14 digits is not an IMDb id; the regex has no trailing boundary so the first 9 digits are used.
    const r = await submit({ imdbId: "tt01234567890123" });
    if (r.ok) expect(lastAddArg().imdbId).not.toBe("tt012345678");
    else expect(r.code).toBe("no-imdb");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// movieYear
// ─────────────────────────────────────────────────────────────────────────────
describe("movieYear", () => {
  it.each([["2007", 2007], ["1900", 1900], ["1801", 1801], ["2999", 2999]])(
    "valid year %j is forwarded as %j",
    async (raw, expected) => {
      await submit({ movieYear: raw });
      expect(lastAddArg().movieYear).toBe(expected);
    },
  );

  it.each(["abc", "NaN", "Infinity", "-Infinity", "12abc"])(
    "non-numeric year %j becomes undefined",
    async (raw) => {
      await submit({ movieYear: raw });
      expect(lastAddArg().movieYear).toBeUndefined();
    },
  );

  // movies.release_year has CHECK (> 1800 and < 3000) and the DB columns are int4.
  // addSubmission persists movie_year verbatim and ensureCommunityMovieForSubmission
  // later reuses it as release_year, so intake must never forward an out-of-range value.
  const badYears = ["", "   ", "0", "-5", "1500", "1800", "3000", "99999", "1999.7", "1e12", "4294967296"];
  for (const raw of badYears) {
    it(`BUG: out-of-range / non-integer movieYear ${JSON.stringify(raw)} is forwarded to addSubmission`, async () => {
      const r = await submit({ movieYear: raw });
      if (!r.ok) return; // rejecting cleanly is also acceptable
      const year = lastAddArg().movieYear;
      expect(
        year === undefined || (Number.isInteger(year) && year > 1800 && year < 3000),
        `movieYear forwarded as ${String(year)}`,
      ).toBe(true);
    });
  }

  it("BUG: movieYear omitted entirely becomes 0 (Number('')) instead of undefined", async () => {
    const fd = makeForm();
    fd.delete("movieYear");
    // formData.get() === null -> `null || ""` -> Number("") === 0
    await executePublicSightingSubmit(fd, nextIp());
    expect(lastAddArg().movieYear).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// season / episode
// ─────────────────────────────────────────────────────────────────────────────
describe("season / episode numbers", () => {
  const series = (o: Overrides = {}) => ({ imdbKind: "series", seasonNumber: "2", episodeNumber: "5", ...o });

  it("accepts a normal episode", async () => {
    const r = await submit(series());
    expect(r.ok).toBe(true);
    expect(lastAddArg()).toMatchObject({ imdbKind: "series", seasonNumber: 2, episodeNumber: 5 });
  });

  it.each([
    ["0", "1"],
    ["1", "0"],
    ["-1", "3"],
    ["3", "-9"],
    ["abc", "1"],
    ["1", ""],
    ["", ""],
    ["NaN", "NaN"],
    ["0.5", "1"], // parseInt("0.5") === 0
  ])("series with season=%j episode=%j is rejected as missing", async (season, episode) => {
    const r = await submit(series({ seasonNumber: season, episodeNumber: episode }));
    expect(r).toMatchObject({ ok: false, code: "missing" });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("float season/episode never reach addSubmission as non-integers", async () => {
    await submit(series({ seasonNumber: "2.9", episodeNumber: "5.1" }));
    const arg = lastAddArg();
    expect(Number.isInteger(arg.seasonNumber)).toBe(true);
    expect(Number.isInteger(arg.episodeNumber)).toBe(true);
  });

  it("imdbKind=movie drops season/episode even when supplied", async () => {
    await submit({ imdbKind: "movie", seasonNumber: "3", episodeNumber: "4", episodeTitle: "Pilot" });
    const arg = lastAddArg();
    expect(arg.imdbKind).toBe("movie");
    expect(arg.seasonNumber).toBeUndefined();
    expect(arg.episodeNumber).toBeUndefined();
  });

  it("BUG: imdbKind=movie still stores an episodeTitle supplied by the client", async () => {
    // Moderation / community-movie code treats episode context as series-only.
    await submit({ imdbKind: "movie", episodeTitle: "Pilot" });
    expect(lastAddArg().episodeTitle).toBeUndefined();
  });

  it.each(["MOVIE", "film", "tv", "", "  "])("unknown imdbKind %j falls back to 'movie'", async (kind) => {
    await submit({ imdbKind: kind });
    expect(lastAddArg().imdbKind).toBe("movie");
  });

  it("imdbKind 'SERIES ' is case/space-insensitive", async () => {
    const r = await submit(series({ imdbKind: "  SeRiEs " }));
    expect(r.ok).toBe(true);
    expect(lastAddArg().imdbKind).toBe("series");
  });

  // submissions.season_number / episode_number are int4.
  for (const huge of ["2147483648", "99999999999", "9007199254740993", "9".repeat(40)]) {
    it(`BUG: season ${huge.slice(0, 20)}… overflows int4 and is forwarded to the DB`, async () => {
      const r = await submit(series({ seasonNumber: huge, episodeNumber: "1" }));
      if (!r.ok) {
        expect(r.code).not.toBe("server-error");
        return;
      }
      expect(lastAddArg().seasonNumber).toBeLessThanOrEqual(2147483647);
    });
  }

  it("BUG: episode number overflowing int4 is forwarded to the DB", async () => {
    const r = await submit(series({ seasonNumber: "1", episodeNumber: "2147483648" }));
    if (!r.ok) return;
    expect(lastAddArg().episodeNumber).toBeLessThanOrEqual(2147483647);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// approximateRatCount
// ─────────────────────────────────────────────────────────────────────────────
describe("approximateRatCount", () => {
  it.each([
    ["abc", 1],
    ["", 1],
    ["-5", 1],
    ["0", 1],
    ["1", 1],
    ["12", 12],
    ["12.9", 12],
    ["9999", 9999],
    ["10000", 9999],
    ["999999999999999999999999", 9999],
    ["  7  ", 7],
    ["NaN", 1],
    ["Infinity", 1],
  ])("count %j is clamped to %j", async (raw, expected) => {
    await submit({ approximateRatCount: raw });
    expect(lastAddArg().approximateRatCount).toBe(expected);
  });

  it("missing count defaults to 1", async () => {
    await submit();
    expect(lastAddArg().approximateRatCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// timestamp
// ─────────────────────────────────────────────────────────────────────────────
describe("timestamp", () => {
  it.each([
    ["42%", "42%"],
    ["42 %", "42%"],
    ["  42  ", "42%"],
    ["042", "42%"],
    ["0%", "0%"],
    ["100%", "100%"],
    ["1:02:03", "1:02:03"],
    ["12:30", "12:30"],
  ])("valid timestamp %j is stored as %j", async (raw, expected) => {
    const r = await submit({ timestamp: raw });
    expect(r.ok).toBe(true);
    expect(lastAddArg().timestamp).toBe(expected);
  });

  it("empty timestamp is rejected as missing", async () => {
    const r = await submit({ timestamp: "" });
    expect(r).toMatchObject({ ok: false, code: "missing" });
  });

  it("an over-range percentage is never stored above 100%", async () => {
    const r = await submit({ timestamp: "150%" });
    if (!r.ok) return; // rejecting is fine too
    expect(lastAddArg().timestamp).toBe("100%");
  });

  for (const junk of ["abc", "-5", "42%%", "<script>alert(1)</script>", "1:2:3:4", "12:99:99x", "1e3%"]) {
    it(`BUG: junk timestamp ${JSON.stringify(junk)} is accepted verbatim`, async () => {
      // Public submissions should only carry a percentage or a colon timecode;
      // anything else ends up unparsable on the movie page / sort order.
      const r = await submit({ timestamp: junk });
      if (!r.ok) return;
      const stored = lastAddArg().timestamp;
      expect(stored).toMatch(/^(\d{1,3}%|\d{1,2}(:\d{1,2}){1,2})$/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Length caps / hostile text
// ─────────────────────────────────────────────────────────────────────────────
describe("free-text length", () => {
  const ONE_MB = "x".repeat(1024 * 1024);
  // Anything above this per field would be absurd for a movie title / sighting note.
  const SANE_MAX = 10_000;

  const cases: Array<[string, Overrides, (arg: ReturnType<typeof lastAddArg>) => string | undefined, Overrides?]> = [
    ["movieTitle", { movieTitle: ONE_MB }, (a) => a.movieTitle],
    ["sightingTitle", { sightingTitle: ONE_MB }, (a) => a.title],
    ["description", { description: ONE_MB }, (a) => a.description],
    ["submitterName", { submitterName: ONE_MB }, (a) => a.submittedBy],
    ["episodeTitle", { episodeTitle: ONE_MB }, (a) => a.episodeTitle, { imdbKind: "series", seasonNumber: "1", episodeNumber: "1" }],
    ["moviePosterUrl", { moviePosterUrl: "https://placehold.co/" + ONE_MB }, (a) => a.moviePosterUrl],
    ["timestamp", { timestamp: ONE_MB }, (a) => a.timestamp],
  ];
  for (const [name, overrides, pick, extra] of cases) {
    it(`BUG: 1 MB ${name} is accepted and forwarded to addSubmission (no length cap)`, async () => {
      const r = await submit({ ...(extra ?? {}), ...overrides });
      if (!r.ok) return;
      const value = pick(lastAddArg());
      expect(value?.length ?? 0).toBeLessThanOrEqual(SANE_MAX);
    });
  }

  it("otherRodentLabel is truncated to MAX_OTHER_RODENT_LABEL_LENGTH", async () => {
    const fd = makeForm();
    fd.append("rodentTypes", "other");
    fd.set("otherRodentLabel", "c".repeat(5000));
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r.ok).toBe(true);
    expect(lastAddArg().otherRodentLabel).toHaveLength(MAX_OTHER_RODENT_LABEL_LENGTH);
  });

  it("otherRodentLabel with only whitespace after truncation window still counts as empty", async () => {
    const fd = makeForm();
    fd.append("rodentTypes", "other");
    fd.set("otherRodentLabel", "   ");
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r).toMatchObject({ ok: false, code: "missing" });
  });

  it("contentWarningOther is truncated to 200 chars", async () => {
    const r = await submit({ contentWarningOther: "w".repeat(5000) });
    expect(r.ok).toBe(true);
    expect(lastAddArg().contentWarnings).toEqual(["w".repeat(200)]);
  });

  it("BUG: NUL (\\u0000) bytes are passed through to Postgres text columns", async () => {
    // Postgres rejects 0x00 in text -> addSubmission throws -> client gets a 500.
    const fd = makeForm({
      movieTitle: "Rata\u0000touille",
      sightingTitle: "Rat\u0000",
      description: "des\u0000c",
      submitterName: "Al\u0000ice",
      moviePosterUrl: "https://placehold.co/a\u0000.png",
      episodeTitle: "ep\u0000",
    });
    fd.append("contentWarnings", "w\u0000");
    fd.append("rodentTypes", "mou\u0000se");
    const r = await executePublicSightingSubmit(fd, nextIp());
    if (!r.ok) {
      expect(r.code).not.toBe("server-error");
      return;
    }
    expect(JSON.stringify(lastAddArg())).not.toContain("\\u0000");
  });

  it("emoji, RTL and combining text survive untouched", async () => {
    const title = "🐀 שלום עולם مرحبا Ñandú é";
    const r = await submit({ sightingTitle: title, description: title, submitterName: title });
    expect(r.ok).toBe(true);
    expect(lastAddArg()).toMatchObject({ title, description: title, submittedBy: title });
  });

  it("SQL / HTML metacharacters are forwarded as plain values (not rewritten, no throw)", async () => {
    const evil = `Robert'); DROP TABLE submissions;-- <img src=x onerror=alert(1)> \${x} {{7*7}}`;
    const r = await submit({ sightingTitle: evil, description: evil, submitterName: evil });
    expect(r.ok).toBe(true);
    expect(lastAddArg()).toMatchObject({ title: evil, description: evil, submittedBy: evil });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rodentTypes / contentWarnings
// ─────────────────────────────────────────────────────────────────────────────
describe("rodentTypes and contentWarnings", () => {
  const known = RODENT_TYPE_OPTIONS.map((o) => o.id as string);

  it("empty rodentTypes -> undefined (DB default applies)", async () => {
    await submit();
    expect(lastAddArg().rodentTypes).toBeUndefined();
  });

  it("blank rodentTypes entries are dropped", async () => {
    const fd = makeForm();
    fd.append("rodentTypes", "   ");
    fd.append("rodentTypes", "");
    await executePublicSightingSubmit(fd, nextIp());
    expect(lastAddArg().rodentTypes).toBeUndefined();
  });

  it("BUG: unknown rodent type ids are persisted verbatim", async () => {
    const fd = makeForm();
    for (const t of ["dragon", "'; drop table--", "<b>x</b>", "RAT", "mouse"]) fd.append("rodentTypes", t);
    const r = await executePublicSightingSubmit(fd, nextIp());
    if (!r.ok) return;
    const types = lastAddArg().rodentTypes ?? [];
    for (const t of types) expect([...known, "other"]).toContain(t);
  });

  it("BUG: duplicate rodent type ids are not de-duplicated", async () => {
    const fd = makeForm();
    for (const t of ["rat", "rat", "mouse", "rat"]) fd.append("rodentTypes", t);
    await executePublicSightingSubmit(fd, nextIp());
    const types = lastAddArg().rodentTypes ?? [];
    expect(new Set(types).size).toBe(types.length);
  });

  it("BUG: 10,000 rodentTypes entries are accepted (no cap)", async () => {
    const fd = makeForm();
    for (let i = 0; i < 10_000; i++) fd.append("rodentTypes", "rat");
    const r = await executePublicSightingSubmit(fd, nextIp());
    if (!r.ok) return;
    expect((lastAddArg().rodentTypes ?? []).length).toBeLessThanOrEqual(known.length + 1);
  });

  it("BUG: 10,000 contentWarnings entries are accepted (no cap)", async () => {
    const fd = makeForm();
    for (let i = 0; i < 10_000; i++) fd.append("contentWarnings", `w${i}`);
    const r = await executePublicSightingSubmit(fd, nextIp());
    if (!r.ok) return;
    expect((lastAddArg().contentWarnings ?? []).length).toBeLessThanOrEqual(50);
  });

  it("BUG: a single contentWarnings entry may be arbitrarily long", async () => {
    const fd = makeForm();
    fd.append("contentWarnings", "w".repeat(1024 * 1024));
    const r = await executePublicSightingSubmit(fd, nextIp());
    if (!r.ok) return;
    for (const w of lastAddArg().contentWarnings ?? []) expect(w.length).toBeLessThanOrEqual(200);
  });

  it("contentWarningOther is appended exactly once alongside selected warnings", async () => {
    const fd = makeForm({ contentWarningOther: "custom" });
    fd.append("contentWarnings", "rat-dies");
    await executePublicSightingSubmit(fd, nextIp());
    expect(lastAddArg().contentWarnings).toEqual(["rat-dies", "custom"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client-supplied poster URL
// ─────────────────────────────────────────────────────────────────────────────
describe("moviePosterUrl", () => {
  it("falls back to the catalog poster when the client sends none", async () => {
    mockFind.mockResolvedValueOnce({ id: "m", slug: "m", title: "Ratatouille", posterUrl: "https://image.tmdb.org/t/p/x.jpg" } as never);
    await submit({ moviePosterUrl: "" });
    expect(lastAddArg().moviePosterUrl).toBe("https://image.tmdb.org/t/p/x.jpg");
  });

  it("keeps a legitimate configured-host poster", async () => {
    await submit({ moviePosterUrl: "https://m.media-amazon.com/images/M/x.jpg" });
    expect(lastAddArg().moviePosterUrl).toBe("https://m.media-amazon.com/images/M/x.jpg");
  });

  // Allowed image hosts mirror next.config.ts images.remotePatterns (https only).
  const hostile = [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "http://m.media-amazon.com/x.jpg", // not https -> next/image remotePattern mismatch
    "https://evil.example/track.png", // host not configured
    "//evil.example/track.png", // protocol-relative
    "ftp://evil.example/x.png",
    "file:///etc/passwd",
  ];
  for (const url of hostile) {
    it(`BUG: poster URL ${JSON.stringify(url).slice(0, 50)} is persisted into the moderation queue`, async () => {
      // The URL later reaches <Image src> on /moderation and is copied into
      // movies.poster_url at approval time.
      const r = await submit({ moviePosterUrl: url });
      if (!r.ok) return;
      const stored = lastAddArg().moviePosterUrl;
      expect(stored === undefined || /^https:\/\/(placehold\.co|image\.tmdb\.org|m\.media-amazon\.com|images\.unsplash\.com|i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|where-rat\.s3\.us-east-1\.amazonaws\.com|[^/]+\.public\.blob\.vercel-storage\.com)\//.test(stored)).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Submitter e-mail / marketing opt-in
// ─────────────────────────────────────────────────────────────────────────────
describe("submitterEmail", () => {
  it.each([
    ["alice@example.com", "alice@example.com"],
    ["  alice@example.com  ", "alice@example.com"],
    ["alice@example.com\n", "alice@example.com"], // trailing newline is trimmed away
    ["üser@exämple.com", "üser@exämple.com"],
  ])("accepts %j", async (raw, expected) => {
    await submit({ submitterEmail: raw });
    expect(lastAddArg().submitterEmail).toBe(expected);
  });

  it.each([
    ["multiple @", "a@b@example.com"],
    ["space inside", "al ice@example.com"],
    ["no tld", "alice@example"],
    ["no local", "@example.com"],
    ["no domain", "alice@"],
    ["CRLF header injection", "alice@example.com\r\nBcc: victim@example.com"],
    ["LF header injection", "alice@example.com\nBcc: victim@example.com"],
    ["comma list", "a@example.com,b@example.com"],
    ["display name", "Alice <alice@example.com>"],
    ["tab inside", "alice@exa\tmple.com"],
    ["empty", ""],
    ["whitespace", "   "],
  ])("rejects/omits %s", async (_label, raw) => {
    const r = await submit({ submitterEmail: raw });
    expect(r.ok).toBe(true); // a bad optional email never blocks the submission
    expect(lastAddArg().submitterEmail).toBeUndefined();
  });

  it("accepts exactly 120 chars and drops 121", async () => {
    const local = "a".repeat(120 - "@x.io".length);
    const ok = `${local}@x.io`;
    expect(ok).toHaveLength(120);
    await submit({ submitterEmail: ok });
    expect(lastAddArg().submitterEmail).toBe(ok);

    await submit({ submitterEmail: `a${ok}` });
    expect(lastAddArg().submitterEmail).toBeUndefined();
  });
});

describe("marketingOptIn (double opt-in: the form only OFFERS the subscription)", () => {
  const offerArg = () => mockNotifySubmitter.mock.calls.at(-1)?.[1] as { offerNewsOptIn?: boolean } | undefined;

  it("never stores an address from the form itself, even when ticked", async () => {
    const fd = makeForm({ submitterEmail: "a@example.com" });
    fd.set("marketingOptIn", "on");
    await executePublicSightingSubmit(fd, nextIp());
    expect(mockOptIn).not.toHaveBeenCalled();
  });

  it("ticked with a valid email asks the receipt e-mail to carry the confirm link", async () => {
    const fd = makeForm({ submitterEmail: "a@example.com" });
    fd.set("marketingOptIn", "on");
    await executePublicSightingSubmit(fd, nextIp());
    await Promise.resolve();
    expect(offerArg()).toEqual({ offerNewsOptIn: true });
  });

  it("is not offered when no email is supplied", async () => {
    const fd = makeForm();
    fd.set("marketingOptIn", "on");
    await executePublicSightingSubmit(fd, nextIp());
    await Promise.resolve();
    expect(offerArg()).toEqual({ offerNewsOptIn: false });
  });

  it("is not offered when the email is invalid", async () => {
    const fd = makeForm({ submitterEmail: "not an email" });
    fd.set("marketingOptIn", "on");
    await executePublicSightingSubmit(fd, nextIp());
    await Promise.resolve();
    expect(offerArg()).toEqual({ offerNewsOptIn: false });
  });

  it.each(["true", "1", "yes", "ON", "off", ""])("value %j is not an opt-in (only exact 'on')", async (v) => {
    const fd = makeForm({ submitterEmail: "a@example.com" });
    fd.set("marketingOptIn", v);
    await executePublicSightingSubmit(fd, nextIp());
    await Promise.resolve();
    expect(offerArg()).toEqual({ offerNewsOptIn: false });
  });

  it("a failing receipt e-mail never fails the submission", async () => {
    mockNotifySubmitter.mockRejectedValueOnce(new Error("resend down"));
    const fd = makeForm({ submitterEmail: "a@example.com" });
    fd.set("marketingOptIn", "on");
    const r = await executePublicSightingSubmit(fd, nextIp());
    expect(r.ok).toBe(true);
  });

  it("no receipt (and so no offer) when the submission itself failed", async () => {
    mockNotifySubmitter.mockClear();
    mockAdd.mockRejectedValueOnce(new Error("boom"));
    const fd = makeForm({ submitterEmail: "a@example.com" });
    fd.set("marketingOptIn", "on");
    await executePublicSightingSubmit(fd, nextIp());
    expect(mockNotifySubmitter).not.toHaveBeenCalled();
    expect(mockOptIn).not.toHaveBeenCalled();
  });
});
