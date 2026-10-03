import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ backdrop: vi.fn(), extract: vi.fn() }));
vi.mock("@/lib/tmdb-banner", () => ({ getTmdbBackdropUrl: h.backdrop }));
vi.mock("@/lib/movie-page-palette", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/movie-page-palette")>();
  return { ...actual, extractMoviePagePalette: h.extract };
});

import { getMoviePageVisuals, getMoviePagePalettes, getSyncedMoviePageVisuals } from "@/lib/movie-page-visuals";
import type { Movie } from "@/lib/whererat";

const P = { wash: "#fff9eb", columnWash: "#fffdf6", accent: "#ea580c", heroBloom: "#2b1a10" };
const PD = { wash: "#111111", columnWash: "#0c0c0c", accent: "#d69e2e", heroBloom: "#080808" };

function movie(over: { poster?: string; metadata?: Record<string, unknown>; tmdb?: string; title?: string } = {}): Movie {
  return {
    id: "m1",
    slug: "m1",
    title: over.title ?? "Rata Touille & Co",
    releaseYear: 2007,
    runtimeMinutes: 100,
    genres: [],
    posterTone: "bg-amber-700",
    posterUrl: over.poster ?? "https://img.example/poster.jpg",
    backdropUrl: "",
    posterAlt: "",
    externalIds: { imdb: "tt0382932", tmdb: over.tmdb },
    summary: "",
    metadata: {
      tagline: "",
      rating: "",
      director: "",
      originalLanguage: "",
      productionCountries: [],
      metadataProvider: "IMDb seed",
      lastSyncedAt: "",
      ...(over.metadata ?? {}),
    },
  } as unknown as Movie;
}

beforeEach(() => {
  h.backdrop.mockReset();
  h.extract.mockReset();
  h.backdrop.mockResolvedValue(null);
  h.extract.mockResolvedValue(P);
});

describe("getSyncedMoviePageVisuals", () => {
  it("prefers the TMDB widescreen backdrop and flags it as widescreen", async () => {
    h.backdrop.mockResolvedValue("https://tmdb/backdrop.jpg");
    const out = await getSyncedMoviePageVisuals(movie({ tmdb: "42" }));
    expect(out.bannerUrl).toBe("https://tmdb/backdrop.jpg");
    expect(out.bannerIsWidescreen).toBe(true);
    expect(h.backdrop).toHaveBeenCalledWith({ tmdbId: "42", imdbId: "tt0382932", forceRefresh: undefined });
    expect(h.extract).toHaveBeenCalledWith("https://tmdb/backdrop.jpg");
  });

  it("falls back to the (upsized) poster when there is no backdrop", async () => {
    const poster = "https://m.media-amazon.com/images/M/abc._V1_SX300.jpg";
    const out = await getSyncedMoviePageVisuals(movie({ poster }));
    expect(out.bannerIsWidescreen).toBe(false);
    expect(out.bannerUrl).toContain("_SX1280");
  });

  it("falls back to a title placeholder when there is no poster either (title is URL-encoded)", async () => {
    h.extract.mockResolvedValue(null);
    const out = await getSyncedMoviePageVisuals(movie({ poster: "", title: "Rata Touille & Co" }));
    expect(out.bannerUrl).toBe("https://placehold.co/1200x600/292524/fef3c7/png?text=Rata%20Touille%20%26%20Co");
    expect(out.palette).toBeNull();
    expect(out.paletteDark).toBeNull();
  });

  it("derives a dark palette from the extracted one", async () => {
    const out = await getSyncedMoviePageVisuals(movie());
    expect(out.palette).toEqual(P);
    expect(out.paletteDark).not.toBeNull();
    expect(out.paletteDark).not.toEqual(P);
  });

  it("tries banner, then poster, then raw poster for a palette, stopping at the first success", async () => {
    h.backdrop.mockResolvedValue("https://tmdb/b.jpg");
    h.extract.mockResolvedValueOnce(null).mockResolvedValueOnce(P);
    const out = await getSyncedMoviePageVisuals(movie({ poster: "https://img.example/p.jpg" }));
    expect(h.extract.mock.calls.map(([u]) => u)).toEqual(["https://tmdb/b.jpg", "https://img.example/p.jpg"]);
    expect(out.palette).toEqual(P);
  });

  it("returns null palettes when extraction fails everywhere", async () => {
    h.backdrop.mockResolvedValue("https://tmdb/b.jpg");
    h.extract.mockResolvedValue(null);
    const out = await getSyncedMoviePageVisuals(movie());
    expect(out.palette).toBeNull();
    expect(out.paletteDark).toBeNull();
  });

  describe("cached palette from the last sync", () => {
    it("is used without any image processing, with an explicit dark palette when cached", async () => {
      const out = await getSyncedMoviePageVisuals(
        movie({ metadata: { syncedPalette: P, syncedPaletteDark: PD } }),
      );
      expect(out.palette).toEqual(P);
      expect(out.paletteDark).toEqual(PD);
      expect(h.extract).not.toHaveBeenCalled();
    });

    it("derives the dark palette if only the light one is cached", async () => {
      const out = await getSyncedMoviePageVisuals(movie({ metadata: { syncedPalette: P } }));
      expect(out.palette).toEqual(P);
      expect(out.paletteDark).not.toBeNull();
    });

    it("normalises cached hex (no '#', upper-case)", async () => {
      const out = await getSyncedMoviePageVisuals(
        movie({ metadata: { syncedPalette: { wash: "FFF9EB", columnWash: "#FFFDF6", accent: "EA580C", heroBloom: "2B1A10" } } }),
      );
      expect(out.palette).toEqual(P);
    });

    it("is ignored when malformed (any field missing or not 6-digit hex)", async () => {
      for (const bad of [
        { ...P, accent: "orange" },
        { ...P, wash: "#fff" },
        { wash: P.wash },
        "string",
        42,
        [],
      ]) {
        h.extract.mockClear();
        await getSyncedMoviePageVisuals(movie({ metadata: { syncedPalette: bad } }));
        expect(h.extract).toHaveBeenCalled();
      }
    });

    it("forceRefresh ignores the cache, re-extracts, and tells TMDB to refresh", async () => {
      const out = await getSyncedMoviePageVisuals(
        movie({ metadata: { syncedPalette: { ...P, accent: "#000000" } } }),
        { forceRefresh: true },
      );
      expect(h.extract).toHaveBeenCalled();
      expect(out.palette).toEqual(P);
      expect(h.backdrop).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    });
  });

  it("BUG: when banner and poster are the same URL, a failing extraction is retried 3x on the identical URL (up to 3x14s)", async () => {
    h.extract.mockResolvedValue(null);
    await getSyncedMoviePageVisuals(movie({ poster: "https://img.example/only.jpg" }));
    const distinct = new Set(h.extract.mock.calls.map(([u]) => u));
    expect(h.extract.mock.calls.length).toBe(distinct.size);
  });
});

describe("getMoviePageVisuals", () => {
  it("returns synced visuals when nothing is overridden", async () => {
    const out = await getMoviePageVisuals(movie());
    expect(out).toMatchObject({
      palette: P,
      syncedPalette: P,
      usingManualPalette: false,
      usingManualPaletteDark: false,
      usingOverrideAccent: false,
      bannerUrl: "https://img.example/poster.jpg",
      syncedBannerUrl: "https://img.example/poster.jpg",
      bannerIsWidescreen: false,
    });
  });

  it("a stored synced banner wins and is treated as widescreen (and TMDB's pick is still reported as synced)", async () => {
    h.backdrop.mockResolvedValue("https://tmdb/new.jpg");
    const out = await getMoviePageVisuals(movie({ metadata: { syncedHeaderBannerUrl: "https://stored/banner.jpg" } }));
    expect(out.bannerUrl).toBe("https://stored/banner.jpg");
    expect(out.bannerIsWidescreen).toBe(true);
    expect(out.syncedBannerUrl).toBe("https://tmdb/new.jpg");
    expect(out.syncedBannerIsWidescreen).toBe(true);
  });

  it("ignores a blank / non-string stored banner", async () => {
    for (const bad of ["", 5, null]) {
      const out = await getMoviePageVisuals(movie({ metadata: { syncedHeaderBannerUrl: bad } }));
      expect(out.bannerUrl).toBe("https://img.example/poster.jpg");
    }
  });

  it("overrideAccent builds the palette and takes precedence over pagePalette", async () => {
    const out = await getMoviePageVisuals(
      movie({ metadata: { overrideAccent: "#336699", pagePalette: { ...P, accent: "#ff0000" } } }),
    );
    expect(out.usingOverrideAccent).toBe(true);
    expect(out.usingManualPalette).toBe(true);
    expect(out.palette!.accent).toBe("#336699");
    expect(out.syncedPalette).toEqual(P);
  });

  it("an invalid overrideAccent falls back to pagePalette, then to synced", async () => {
    const withPalette = await getMoviePageVisuals(
      movie({ metadata: { overrideAccent: "banana", pagePalette: { wash: "#aaaaaa", columnWash: "#bbbbbb", accent: "#cccccc", heroBloom: "#dddddd" } } }),
    );
    expect(withPalette.usingOverrideAccent).toBe(false);
    expect(withPalette.usingManualPalette).toBe(true);
    expect(withPalette.palette!.accent).toBe("#cccccc");
    const without = await getMoviePageVisuals(movie({ metadata: { overrideAccent: "banana" } }));
    expect(without.usingManualPalette).toBe(false);
    expect(without.palette).toEqual(P);
  });

  it("an explicitly cleared overrideAccent (null) is treated as unset", async () => {
    const out = await getMoviePageVisuals(movie({ metadata: { overrideAccent: null } }));
    expect(out.usingOverrideAccent).toBe(false);
  });

  it("manual dark palette overrides the synced dark palette independently", async () => {
    const out = await getMoviePageVisuals(movie({ metadata: { pagePaletteDark: PD } }));
    expect(out.paletteDark).toEqual(PD);
    expect(out.usingManualPaletteDark).toBe(true);
    expect(out.usingManualPalette).toBe(false);
    expect(out.palette).toEqual(P);
    expect(out.syncedPaletteDark).not.toEqual(PD);
  });

  it("rejects partially-valid manual palettes", async () => {
    const out = await getMoviePageVisuals(
      movie({ metadata: { pagePalette: { wash: "#aaaaaa", columnWash: "bad", accent: "#cccccc", heroBloom: "#dddddd" } } }),
    );
    expect(out.usingManualPalette).toBe(false);
  });

  it("normalises manual palette colours", async () => {
    const out = await getMoviePageVisuals(
      movie({ metadata: { pagePalette: { wash: "AAAAAA", columnWash: " #BBBBBB ", accent: "CCCCCC", heroBloom: "DDDDDD" } } }),
    );
    expect(out.palette).toEqual({ wash: "#aaaaaa", columnWash: "#bbbbbb", accent: "#cccccc", heroBloom: "#dddddd" });
  });
});

describe("getMoviePagePalettes (list-view fast path)", () => {
  const manual = { wash: "#aaaaaa", columnWash: "#bbbbbb", accent: "#cccccc", heroBloom: "#dddddd" };
  const manualDark = { wash: "#010101", columnWash: "#020202", accent: "#030303", heroBloom: "#040404" };

  it("uses a sync-cached palette without any TMDB or image request", async () => {
    const m = movie({ metadata: { syncedPalette: P, syncedPaletteDark: PD } });
    expect(await getMoviePagePalettes(m)).toEqual({ palette: P, paletteDark: PD });
    expect(h.backdrop).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
  });

  it("derives the dark palette when only the light one was cached", async () => {
    const out = await getMoviePagePalettes(movie({ metadata: { syncedPalette: P } }));
    expect(out.palette).toEqual(P);
    expect(out.paletteDark).not.toBeNull();
    expect(h.extract).not.toHaveBeenCalled();
  });

  it("manual palettes win over the cached one", async () => {
    const m = movie({
      metadata: { syncedPalette: P, syncedPaletteDark: PD, pagePalette: manual, pagePaletteDark: manualDark },
    });
    expect(await getMoviePagePalettes(m)).toEqual({ palette: manual, paletteDark: manualDark });
  });

  it("a manual light palette alone keeps the cached dark one", async () => {
    const m = movie({ metadata: { syncedPalette: P, syncedPaletteDark: PD, pagePalette: manual } });
    expect(await getMoviePagePalettes(m)).toEqual({ palette: manual, paletteDark: PD });
  });

  it("a complete manual pair needs no network even with nothing cached", async () => {
    const m = movie({ metadata: { pagePalette: manual, pagePaletteDark: manualDark } });
    expect(await getMoviePagePalettes(m)).toEqual({ palette: manual, paletteDark: manualDark });
    expect(h.backdrop).not.toHaveBeenCalled();
    expect(h.extract).not.toHaveBeenCalled();
  });

  it("falls back to full extraction when nothing is stored", async () => {
    const out = await getMoviePagePalettes(movie());
    expect(h.extract).toHaveBeenCalled();
    expect(out.palette).toEqual(P);
  });

  it("a manual light palette with nothing cached still extracts the dark one (same as the full visuals)", async () => {
    const m = movie({ metadata: { pagePalette: manual } });
    const fast = await getMoviePagePalettes(m);
    const full = await getMoviePageVisuals(m);
    expect(fast).toEqual({ palette: full.palette, paletteDark: full.paletteDark });
  });

  it.each([
    ["nothing stored", {}],
    ["cached only", { syncedPalette: P }],
    ["cached pair", { syncedPalette: P, syncedPaletteDark: PD }],
    ["manual light", { pagePalette: manual }],
    ["manual pair", { pagePalette: manual, pagePaletteDark: manualDark }],
    ["override accent", { overrideAccent: "#ea580c" }],
    ["override accent + cached", { overrideAccent: "#ea580c", syncedPalette: P }],
  ])("returns exactly what getMoviePageVisuals does: %s", async (_name, metadata) => {
    const m = movie({ metadata });
    const fast = await getMoviePagePalettes(m);
    const full = await getMoviePageVisuals(m);
    expect(fast).toEqual({ palette: full.palette, paletteDark: full.paletteDark });
  });
});
