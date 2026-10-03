/**
 * Edge-case coverage for small pure helpers that sit on the submit / moderation
 * path: normalizeImdbId, clampApproximateRatCount, normalizeSightingTimestampInput,
 * getSubmissionSightingTitle and parseMovieIdentityEdits. (The existing
 * whererat.test.ts / movie-identity-form.test.ts cover only the happy paths.)
 */
import { describe, it, expect } from "vitest";
import {
  normalizeImdbId,
  clampApproximateRatCount,
  normalizeSightingTimestampInput,
  getSubmissionSightingTitle,
  type Submission,
} from "@/lib/whererat";
import { parseMovieIdentityEdits } from "@/lib/movie-identity-form";

const sub = (over: Partial<Submission> = {}): Submission => ({
  id: "s",
  movieTitle: "M",
  timestamp: "1%",
  description: "",
  spoiler: false,
  approximateRatCount: 1,
  status: "pending",
  submittedBy: "x",
  submittedAt: new Date(0),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeImdbId edge cases", () => {
  it.each([
    ["tt0382932", "tt0382932"],
    ["TT0382932", "tt0382932"],
    ["Tt0382932", "tt0382932"],
    ["  tt0382932\n", "tt0382932"],
    ["tt0382932 tt0000001", "tt0382932"], // first wins
    ["https://www.imdb.com/title/tt0382932/", "tt0382932"],
    ["https://m.imdb.com/title/tt0382932/reference?x=tt0000001", "tt0382932"],
    ["imdb.com/title/tt0382932", "tt0382932"],
    ["tt1234567", "tt1234567"], // 7 digits
    ["tt12345678", "tt12345678"], // 8 digits (current IMDb ids)
    ["tt123456789", "tt123456789"], // 9 digits (upper bound of the regex)
    ["line1\nline2 tt0382932", "tt0382932"],
    ["tt0382932'; DROP TABLE movies;--", "tt0382932"],
    ["<script>tt0382932</script>", "tt0382932"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeImdbId(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "tt",
    "tt123456", // 6 digits
    "t0382932",
    "nm0000123", // IMDb *name* id
    "ch0000123",
    "0382932",
    "ttabcdefg",
    "tt 0382932",
    "tt-0382932",
    "tt٠١٢٣٤٥٦", // Arabic-Indic digits are not \d in this regex
    "ｔｔ０３８２９３２", // full-width forms
    "null",
    "undefined",
  ])("rejects %j", (input) => {
    expect(normalizeImdbId(input)).toBe("");
  });

  it("never returns more than 'tt' + 9 digits and always matches /^tt\\d{7,9}$/", () => {
    for (const input of ["tt0382932", "x".repeat(100) + "tt0382932" + "y".repeat(100), "tt" + "9".repeat(50)]) {
      const out = normalizeImdbId(input);
      if (out) expect(out).toMatch(/^tt\d{7,9}$/);
    }
  });

  it("is linear-time on pathological 1 MB inputs (no ReDoS)", () => {
    const start = performance.now();
    normalizeImdbId("tt".repeat(512 * 1024));
    normalizeImdbId("t".repeat(1024 * 1024));
    normalizeImdbId("tt123456".repeat(128 * 1024));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("BUG: an over-long digit run is truncated to the first 9 digits instead of being rejected", () => {
    expect(normalizeImdbId("tt0123456789012345")).toBe("");
  });

  it("BUG: a 10+ digit id is truncated into a *different* valid-looking id", () => {
    expect(normalizeImdbId("tt0123456789")).not.toBe("tt012345678");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("clampApproximateRatCount edge cases", () => {
  it.each([
    ["1", 1],
    ["0", 1],
    ["-0", 1],
    ["-1", 1],
    ["+5", 5],
    ["00012", 12],
    ["  7 ", 7],
    ["12abc", 12], // parseInt leniency
    ["abc12", 1],
    ["12.99", 12],
    ["9999", 9999],
    ["9999.9", 9999],
    ["10000", 9999],
    ["1".padEnd(30, "0"), 9999],
    ["0x10", 1], // parseInt radix 10 -> 0
    ["1e3", 1], // parseInt stops at 'e'
    ["", 1],
    ["   ", 1],
    ["٣", 1], // Arabic-indic digit
    ["NaN", 1],
    ["Infinity", 1],
    ["-Infinity", 1],
    ["null", 1],
  ])("string %j -> %j", (input, expected) => {
    expect(clampApproximateRatCount(input)).toBe(expected);
  });

  it.each([
    [undefined, 1],
    [null, 1],
    [NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [{}, 1],
    [[], 1],
    [[5], 5], // String([5]) === "5"
    [true, 1],
    [0, 1],
    [1, 1],
    [42, 42],
    [42.9, 42],
    [-42, 1],
    [9999, 9999],
    [1e6, 9999],
    [Number.MAX_SAFE_INTEGER, 9999],
  ])("value %o -> %j", (input, expected) => {
    expect(clampApproximateRatCount(input as never)).toBe(expected);
  });

  it("always returns an integer in [1, 9999]", () => {
    const samples: unknown[] = ["-1e9", "1e9", "5.5", 0.1, -0.1, 1e300, "٣", "  ", "9".repeat(20), 123456789];
    for (const s of samples) {
      const n = clampApproximateRatCount(s);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(9999);
    }
  });

  it("is monotonic for ordinary growing inputs", () => {
    let prev = 0;
    for (const n of ["1", "10", "100", "1000", "9999", "10000", "100000", "1" + "0".repeat(20)]) {
      const v = clampApproximateRatCount(n);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("BUG: a digit string too long for a double (>308 digits) parses to Infinity and collapses to 1 instead of clamping to 9999", () => {
    expect(clampApproximateRatCount("9".repeat(400))).toBe(9999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeSightingTimestampInput edge cases", () => {
  it.each([
    ["42", "42%"],
    ["042", "42%"],
    ["0", "0%"],
    ["000", "0%"],
    ["100", "100%"],
    ["101", "100%"], // clamped, not rejected
    ["999%", "100%"],
    ["42%", "42%"],
    ["42 %", "42%"],
    ["42 %", "42%"], // NBSP is \s
    ["  42  ", "42%"],
    ["\t42%\n", "42%"],
  ])("percent-like %j -> %j", (input, expected) => {
    expect(normalizeSightingTimestampInput(input)).toBe(expected);
  });

  it.each([
    ["1:02:03", "1:02:03"],
    ["  1:02:03  ", "1:02:03"],
    ["12:30", "12:30"],
    ["0:00", "0:00"],
  ])("timecode %j is kept (trimmed) -> %j", (input, expected) => {
    expect(normalizeSightingTimestampInput(input)).toBe(expected);
  });

  it.each([
    ["", ""],
    ["   ", ""],
    ["\n\t", ""],
  ])("blank %j -> empty (caller must treat as missing)", (input, expected) => {
    expect(normalizeSightingTimestampInput(input)).toBe(expected);
  });

  it.each([
    ["-5", "-5"],
    ["abc", "abc"],
    ["42%%", "42%%"],
    ["4 2%", "4 2%"],
    ["1000", "1000"], // 4 digits do not match the percent pattern
    ["42.5%", "42.5%"],
    ["1e2", "1e2"],
    ["٤٢", "٤٢"],
  ])("non-percent text %j is passed through UNVALIDATED -> %j", (input, expected) => {
    // Documents current behaviour: this helper normalises, it does not validate.
    expect(normalizeSightingTimestampInput(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const v of ["42", "42 %", "  1:02:03 ", "abc", "", "101"]) {
      const once = normalizeSightingTimestampInput(v);
      expect(normalizeSightingTimestampInput(once)).toBe(once);
    }
  });

  it("does not choke on very large input", () => {
    const start = performance.now();
    const out = normalizeSightingTimestampInput("9".repeat(1024 * 1024));
    expect(out).toHaveLength(1024 * 1024);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getSubmissionSightingTitle edge cases", () => {
  it("prefers a non-blank explicit title (trimmed)", () => {
    expect(getSubmissionSightingTitle(sub({ title: "  Rat on counter ", description: "ignored." }))).toBe("Rat on counter");
  });

  it.each([undefined, "", "   ", "\n\t "])("blank title %j falls back to the description", (title) => {
    expect(getSubmissionSightingTitle(sub({ title, description: "A rat scurries. Then more." }))).toBe("A rat scurries.");
  });

  it("uses the first sentence ending in . ! or ?", () => {
    expect(getSubmissionSightingTitle(sub({ description: "Wow! Another one." }))).toBe("Wow!");
    expect(getSubmissionSightingTitle(sub({ description: "Is that a rat? Yes." }))).toBe("Is that a rat?");
  });

  it("sentence punctuation not followed by whitespace/end does not end the sentence", () => {
    expect(getSubmissionSightingTitle(sub({ description: "See v2.0 of the scene" }))).toBe("See v2.0 of the scene");
  });

  it("leading whitespace/newlines in the description are ignored", () => {
    expect(getSubmissionSightingTitle(sub({ description: "\n\n  A rat appears.  " }))).toBe("A rat appears.");
  });

  it("a sentence longer than 200 chars falls through to the 117 + ellipsis truncation", () => {
    const long = "word ".repeat(80) + "end."; // > 200 chars before the first full stop
    const out = getSubmissionSightingTitle(sub({ description: long }));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(118);
  });

  it("no punctuation, short text is returned as is; exactly 120 chars is not truncated, 121 is", () => {
    expect(getSubmissionSightingTitle(sub({ description: "a".repeat(120) }))).toBe("a".repeat(120));
    expect(getSubmissionSightingTitle(sub({ description: "a".repeat(121) }))).toBe("a".repeat(117) + "…");
  });

  it.each(["", "   ", "\n"])("blank everything (%j) -> 'Sighting'", (description) => {
    expect(getSubmissionSightingTitle(sub({ title: undefined, description }))).toBe("Sighting");
  });

  it("is fast on a 1 MB description (no catastrophic regex backtracking)", () => {
    const start = performance.now();
    getSubmissionSightingTitle(sub({ description: "a ".repeat(512 * 1024) }));
    getSubmissionSightingTitle(sub({ description: "a".repeat(1024 * 1024) }));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("HTML in the headline is returned verbatim (escaping is the renderer's job)", () => {
    expect(getSubmissionSightingTitle(sub({ title: "<img src=x onerror=alert(1)>" }))).toBe("<img src=x onerror=alert(1)>");
  });

  it("BUG: truncation can split a surrogate pair, returning a malformed (lone-surrogate) headline", () => {
    const description = "a".repeat(116) + "🐀" + "b".repeat(40); // 🐀 occupies UTF-16 units 116-117
    const out = getSubmissionSightingTitle(sub({ description }));
    expect(out.isWellFormed()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("parseMovieIdentityEdits edge cases", () => {
  const fd = (entries: Array<[string, string | File]>) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };

  it("an empty form yields no edits", () => {
    expect(parseMovieIdentityEdits(new FormData())).toEqual({ ok: true, edits: {} });
  });

  it("title only / id only are independently supported", () => {
    expect(parseMovieIdentityEdits(fd([["movieTitle", "Life"]]))).toEqual({ ok: true, edits: { movieTitle: "Life" } });
    expect(parseMovieIdentityEdits(fd([["imdbId", "tt0000001"]]))).toEqual({ ok: true, edits: { imdbId: "tt0000001" } });
  });

  it("an invalid half never leaks a partial edit (result has no `edits`)", () => {
    const r = parseMovieIdentityEdits(fd([["movieTitle", "Life"], ["imdbId", "bogus"]]));
    expect(r).toEqual({ ok: false });
    expect("edits" in r).toBe(false);
  });

  it.each(["", " ", "\t\n", " ", " "])("blank/unicode-space title %j is rejected", (title) => {
    expect(parseMovieIdentityEdits(fd([["movieTitle", title]]))).toEqual({ ok: false });
  });

  it("title is trimmed but otherwise untouched (unicode, quotes, SQL, HTML)", () => {
    const t = `  Pokémon: Détective "Pikachu" 🐀 '; DROP TABLE movies;-- <b>x</b> `;
    expect(parseMovieIdentityEdits(fd([["movieTitle", t]]))).toEqual({ ok: true, edits: { movieTitle: t.trim() } });
  });

  it("when a field is posted twice only the first value is used", () => {
    const r = parseMovieIdentityEdits(fd([["movieTitle", "First"], ["movieTitle", "Second"], ["imdbId", "tt0000001"], ["imdbId", "tt0000002"]]));
    expect(r).toEqual({ ok: true, edits: { movieTitle: "First", imdbId: "tt0000001" } });
  });

  it.each([
    ["https://www.imdb.com/title/TT0382932/?ref_=x", "tt0382932"],
    ["  tt0382932  ", "tt0382932"],
    ["tt0382932'; DROP TABLE movies;--", "tt0382932"],
  ])("imdbId %j -> %j", (raw, expected) => {
    expect(parseMovieIdentityEdits(fd([["imdbId", raw]]))).toEqual({ ok: true, edits: { imdbId: expected } });
  });

  it.each(["nm0000123", "tt123", "tt", "", "   ", "https://www.imdb.com/name/nm0000123/"])("imdbId %j is rejected", (raw) => {
    expect(parseMovieIdentityEdits(fd([["imdbId", raw]]))).toEqual({ ok: false });
  });

  it("BUG: a File part in the title field is coerced to the title '[object File]'", () => {
    const r = parseMovieIdentityEdits(fd([["movieTitle", new File(["x"], "x.txt", { type: "text/plain" })]]));
    expect(r).toEqual({ ok: false });
  });

  it("BUG: a title made only of zero-width characters passes the blank check", () => {
    expect(parseMovieIdentityEdits(fd([["movieTitle", "​​"]]))).toEqual({ ok: false });
  });
});
