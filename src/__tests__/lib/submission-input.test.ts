import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SUBMISSION_LIMITS,
  cleanContentWarnings,
  cleanRodentTypes,
  cleanText,
  isOwnStorageUrl,
  isValidTimestamp,
  parseReleaseYear,
  parseSeasonOrEpisode,
  parseStrictInt,
  safeReturnTo,
  sanitizePosterUrl,
  sanitizeRemoteImageUrl,
} from "@/lib/submission-input";

afterEach(() => vi.unstubAllEnvs());

describe("cleanText", () => {
  it("trims, strips NUL and zero-width characters", () => {
    expect(cleanText("  a\u0000b​c﻿ ", 50)).toBe("abc");
  });
  it("returns '' for non-strings (a File part, null, numbers)", () => {
    expect(cleanText(new File(["x"], "x.txt"), 10)).toBe("");
    expect(cleanText(null, 10)).toBe("");
    expect(cleanText(42, 10)).toBe("");
  });
  it("invisible-only text becomes empty", () => {
    expect(cleanText("​‌‍⁠", 10)).toBe("");
  });
  it("caps by code point and never splits an emoji", () => {
    const out = cleanText("🐀".repeat(10), 3);
    expect(Array.from(out)).toHaveLength(3);
    expect(out).toBe("🐀🐀🐀");
  });
  it("leaves text under the cap untouched", () => {
    expect(cleanText("Ratatouille", SUBMISSION_LIMITS.movieTitle)).toBe("Ratatouille");
  });
});

describe("parseStrictInt / year / season", () => {
  it.each([
    ["12", 12],
    [" 12 ", 12],
    ["-3", -3],
  ])("parses %j", (raw, n) => expect(parseStrictInt(raw, -10, 100)).toBe(n));

  it.each(["", "abc", "1e3", "12.5", "0x10", "NaN", "Infinity", "9".repeat(30), "--1", "1 2"])(
    "rejects %j",
    (raw) => expect(parseStrictInt(raw, -1e12, 1e12)).toBeUndefined(),
  );
  it("rejects non-strings", () => {
    expect(parseStrictInt(undefined, 0, 1)).toBeUndefined();
    expect(parseStrictInt(5, 0, 10)).toBeUndefined();
  });

  it.each([["1801", 1801], ["2007", 2007], ["2999", 2999]])("year %j ok", (raw, n) =>
    expect(parseReleaseYear(raw)).toBe(n),
  );
  it.each(["1800", "3000", "0", "-5", "99999999999", "2001.7", "", "abc"])("year %j rejected", (raw) =>
    expect(parseReleaseYear(raw)).toBeUndefined(),
  );

  it("season/episode: positive, within int4, decimals floor", () => {
    expect(parseSeasonOrEpisode("3")).toBe(3);
    expect(parseSeasonOrEpisode("2.9")).toBe(2);
    expect(parseSeasonOrEpisode("2147483647")).toBe(2147483647);
    for (const bad of ["0", "-1", "2147483648", "99999999999", "abc", "", "1e3"]) {
      expect(parseSeasonOrEpisode(bad), bad).toBeUndefined();
    }
  });
});

describe("isValidTimestamp", () => {
  it.each(["0%", "42%", "100%", "1:02:03", "42:00", "00:42:00"])("accepts %j", (v) =>
    expect(isValidTimestamp(v)).toBe(true),
  );
  it.each(["abc", "-5", "42%%", "101%", "1e3%", "1:2:3:4", "12:99:99x", "<script>", "", "9".repeat(40)])(
    "rejects %j",
    (v) => expect(isValidTimestamp(v)).toBe(false),
  );
});

describe("cleanRodentTypes / cleanContentWarnings", () => {
  it("keeps known ids only, de-duplicated, in order", () => {
    expect(cleanRodentTypes(["mouse", "dragon", "rat", "mouse", "RAT", " other ", 5, null])).toEqual([
      "mouse",
      "rat",
      "other",
    ]);
  });
  it("caps the number and length of warnings and drops blanks/dupes", () => {
    const many = Array.from({ length: 500 }, (_, i) => `w${i}`);
    expect(cleanContentWarnings(many)).toHaveLength(SUBMISSION_LIMITS.contentWarnings);
    expect(cleanContentWarnings(["x".repeat(5000), "", "  ", "a", "a"])).toEqual([
      "x".repeat(SUBMISSION_LIMITS.contentWarning),
      "a",
    ]);
  });
});

describe("image URLs", () => {
  it.each([
    "https://image.tmdb.org/t/p/w500/a.jpg",
    "https://m.media-amazon.com/images/M/x.jpg",
    "https://abc123.public.blob.vercel-storage.com/sightings/x.png",
    "https://placehold.co/600x900/png",
  ])("allows %s", (u) => expect(sanitizeRemoteImageUrl(u)).toBeTruthy());

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "http://image.tmdb.org/x.jpg",
    "https://evil.example/track.png",
    "https://image.tmdb.org.evil.example/x.png",
    "https://user:pw@image.tmdb.org/x.png",
    "//evil.example/x.png",
    "ftp://image.tmdb.org/x.png",
    "file:///etc/passwd",
    "",
    "not a url",
  ])("blocks %j", (u) => expect(sanitizeRemoteImageUrl(u)).toBeUndefined());

  it("caps URL length", () => {
    expect(sanitizeRemoteImageUrl("https://placehold.co/" + "a".repeat(3000))).toBeUndefined();
  });

  it("posters may also be a site-relative path, but never protocol-relative", () => {
    expect(sanitizePosterUrl("/uploads/sightings/x.png")).toBe("/uploads/sightings/x.png");
    for (const bad of ["//evil.example/x.png", "/\\evil.example", "\\\\evil", "/a b"]) {
      expect(sanitizePosterUrl(bad), bad).toBeUndefined();
    }
  });

  it("honours S3_PUBLIC_BASE_URL like next.config.ts does", () => {
    vi.stubEnv("S3_PUBLIC_BASE_URL", "https://cdn.example.org/bucket");
    expect(sanitizeRemoteImageUrl("https://cdn.example.org/bucket/a.png")).toBeTruthy();
  });

  it("isOwnStorageUrl: only our upload paths / blob hosts", () => {
    expect(isOwnStorageUrl("/uploads/sightings/0b1a-2c3d.png")).toBe(true);
    expect(isOwnStorageUrl("https://abc.public.blob.vercel-storage.com/sightings/x.png")).toBe(true);
    for (const bad of [
      "https://image.tmdb.org/t/p/x.jpg", // allowed for posters, but not something we stored
      "https://evil.example/x.png",
      "/uploads/../etc/passwd",
      "/uploads/sightings/../../x",
      "/etc/passwd",
      "javascript:alert(1)",
      "",
    ]) {
      expect(isOwnStorageUrl(bad), bad).toBe(false);
    }
  });
});

describe("safeReturnTo", () => {
  it.each(["/moderation", "/movies/x?sort=new", "/"])("keeps %j", (v) => expect(safeReturnTo(v, "/f")).toBe(v));
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil", "javascript:alert(1)", "", "   ", null, undefined, 5])(
    "falls back for %j",
    (v) => expect(safeReturnTo(v, "/f")).toBe("/f"),
  );
});
