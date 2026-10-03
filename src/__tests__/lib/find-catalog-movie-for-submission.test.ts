import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("@/lib/db", () => ({
  getDbPool: () => ({ query: mockQuery }),
}));

import { findCatalogMovieForSubmission } from "@/lib/movie-catalog";

function movieRow(id: string, title: string, imdbId: string, summary = "") {
  return {
    id,
    slug: id,
    title,
    release_year: 2019,
    runtime_minutes: 120,
    genres: [],
    poster_tone: "bg-stone-700",
    poster_url: "/poster.png",
    backdrop_url: "/backdrop.png",
    poster_alt: title,
    imdb_id: imdbId,
    tmdb_id: null,
    summary,
    metadata: {},
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  // getCatalogMovies is the only query this resolver may run — any fuzzy
  // search query would also hit this mock, so assert on call count below.
  mockQuery.mockResolvedValue({
    rows: [
      movieRow(
        "downton",
        "Downton Abbey",
        "tt6398184",
        "The lives of the Crawley family and their servants. Life goes on.",
      ),
      movieRow("jaws", "Jaws", "tt0073195"),
    ],
  });
});

describe("findCatalogMovieForSubmission", () => {
  it("matches by IMDb id", async () => {
    const movie = await findCatalogMovieForSubmission({
      imdbId: "tt0073195",
      movieTitle: "whatever",
    });
    expect(movie?.id).toBe("jaws");
  });

  it("does not fuzzy-match another movie when the IMDb id is not in the catalog", async () => {
    const movie = await findCatalogMovieForSubmission({
      imdbId: "tt1234567",
      movieTitle: "Life",
    });
    expect(movie).toBeUndefined();
    // Only the catalog read — no full-text search over summaries.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("does not match a different movie that merely shares the title when ids differ", async () => {
    const movie = await findCatalogMovieForSubmission({
      imdbId: "tt9999999",
      movieTitle: "Jaws",
    });
    expect(movie).toBeUndefined();
  });

  it("falls back to an exact, case-insensitive title match without an IMDb id", async () => {
    const movie = await findCatalogMovieForSubmission({ movieTitle: "  jaws " });
    expect(movie?.id).toBe("jaws");
  });

  it("does not partially match a title without an IMDb id", async () => {
    const movie = await findCatalogMovieForSubmission({ movieTitle: "Life" });
    expect(movie).toBeUndefined();
  });

  it("returns undefined for a blank title and no id", async () => {
    expect(await findCatalogMovieForSubmission({ movieTitle: "  " })).toBeUndefined();
  });
});
