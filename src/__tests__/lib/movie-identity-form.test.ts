import { describe, it, expect } from "vitest";
import { parseMovieIdentityEdits } from "@/lib/movie-identity-form";

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("parseMovieIdentityEdits", () => {
  it("returns no edits when the form has no title fields", () => {
    expect(parseMovieIdentityEdits(form({ title: "x" }))).toEqual({ ok: true, edits: {} });
  });

  it("trims the title and normalizes an IMDb id or URL", () => {
    const result = parseMovieIdentityEdits(
      form({ movieTitle: "  Life ", imdbId: "https://www.imdb.com/title/TT1234567/" }),
    );
    expect(result).toEqual({ ok: true, edits: { movieTitle: "Life", imdbId: "tt1234567" } });
  });

  it("rejects a blank title", () => {
    expect(parseMovieIdentityEdits(form({ movieTitle: "   " }))).toEqual({ ok: false });
  });

  it("rejects an invalid IMDb id", () => {
    expect(parseMovieIdentityEdits(form({ movieTitle: "Life", imdbId: "nope" }))).toEqual({
      ok: false,
    });
  });
});
