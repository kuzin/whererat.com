/**
 * movie-page-palette.ts. Image decoding is real (sharp) on tiny in-memory
 * images; the network is a stubbed fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";
import {
  buildPaletteFromAccent,
  deriveDarkMoviePagePalette,
  extractMoviePagePalette,
  type MoviePagePalette,
} from "@/lib/movie-page-palette";

const HEX = /^#[0-9a-f]{6}$/;
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
};
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};

function allHex(p: MoviePagePalette) {
  for (const v of Object.values(p)) expect(v).toMatch(HEX);
}

describe("buildPaletteFromAccent", () => {
  it("builds a palette whose accent is the normalised input", () => {
    const p = buildPaletteFromAccent("#EA580C")!;
    expect(p.accent).toBe("#ea580c");
    allHex(p);
  });

  it("accepts a missing '#' and surrounding whitespace", () => {
    expect(buildPaletteFromAccent("  ea580c ")!.accent).toBe("#ea580c");
  });

  it("washes are lighter than the accent; bloom is darker", () => {
    const p = buildPaletteFromAccent("#336699")!;
    expect(lum(p.wash)).toBeGreaterThan(lum(p.accent));
    expect(lum(p.columnWash)).toBeGreaterThan(lum(p.wash));
    expect(lum(p.heroBloom)).toBeLessThan(lum(p.accent));
  });

  it.each(["", "#fff", "red", "#12345g", "#1234567", "rgb(1,2,3)", "#12 456", null as unknown as string])(
    "rejects %j",
    (bad) => {
      if (bad === null) {
        expect(() => buildPaletteFromAccent(bad)).toThrow();
      } else {
        expect(buildPaletteFromAccent(bad)).toBeNull();
      }
    },
  );

  it("handles the extremes without producing invalid hex", () => {
    allHex(buildPaletteFromAccent("#000000")!);
    allHex(buildPaletteFromAccent("#ffffff")!);
  });
});

describe("deriveDarkMoviePagePalette", () => {
  const light: MoviePagePalette = { wash: "#fff9eb", columnWash: "#fffdf6", accent: "#ea580c", heroBloom: "#2b1a10" };

  it("produces valid hex values", () => {
    allHex(deriveDarkMoviePagePalette(light));
  });

  it("is much darker for washes/bloom while keeping the accent readable", () => {
    const dark = deriveDarkMoviePagePalette(light);
    expect(lum(dark.wash)).toBeLessThan(lum(light.wash) / 2);
    expect(lum(dark.columnWash)).toBeLessThan(lum(light.columnWash) / 2);
    expect(lum(dark.heroBloom)).toBeLessThan(lum(light.heroBloom));
    expect(lum(dark.accent)).toBeGreaterThan(60);
  });

  it("falls back to built-in dark defaults for unparseable input instead of throwing", () => {
    const dark = deriveDarkMoviePagePalette({ wash: "nope", columnWash: "", accent: "x", heroBloom: "#12" });
    allHex(dark);
    for (const v of Object.values(dark)) expect(lum(v)).toBeLessThan(200);
  });

  it("is deterministic", () => {
    expect(deriveDarkMoviePagePalette(light)).toEqual(deriveDarkMoviePagePalette(light));
  });
});

describe("extractMoviePagePalette", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const solid = (r: number, g: number, b: number) =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();
  const respond = (buf: Buffer) => fetchMock.mockResolvedValue(new Response(new Uint8Array(buf)));

  it("derives a themed palette from the dominant colour (red image => reddish accent)", async () => {
    respond(await solid(200, 30, 30));
    const p = (await extractMoviePagePalette("https://img.example/red.png"))!;
    expect(p).not.toBeNull();
    allHex(p);
    const [r, g, b] = rgb(p.accent);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(lum(p.wash)).toBeGreaterThan(lum(p.accent));
    expect(lum(p.heroBloom)).toBeLessThan(lum(p.wash));
  });

  it("requests the URL with a timeout signal", async () => {
    respond(await solid(30, 30, 200));
    await extractMoviePagePalette("https://img.example/blue.png");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://img.example/blue.png");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["grey", [128, 128, 128]],
    ["white", [255, 255, 255]],
    ["black", [0, 0, 0]],
  ] as const)("a %s image has no dominant colour; still yields a valid palette via mean-colour fallback", async (_n, c) => {
    respond(await solid(c[0], c[1], c[2]));
    const p = (await extractMoviePagePalette("https://img.example/x.png"))!;
    expect(p).not.toBeNull();
    allHex(p);
  });

  it("returns null when the network fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await extractMoviePagePalette("https://img.example/x.png")).toBeNull();
  });

  it("returns null when the response is not an image", async () => {
    fetchMock.mockResolvedValue(new Response("<html>404</html>", { status: 404 }));
    expect(await extractMoviePagePalette("https://img.example/x.png")).toBeNull();
  });

  it("returns null for an empty body or a truncated image", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(0)));
    expect(await extractMoviePagePalette("https://img.example/x.png")).toBeNull();
    const buf = await solid(1, 2, 3);
    fetchMock.mockResolvedValue(new Response(new Uint8Array(buf.subarray(0, 20))));
    expect(await extractMoviePagePalette("https://img.example/x.png")).toBeNull();
  });

  it("returns null when the abort timeout fires", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await extractMoviePagePalette("https://img.example/x.png")).toBeNull();
  });

  it("handles a multi-colour image by picking a colour present in it", async () => {
    const buf = await sharp({
      create: { width: 96, height: 96, channels: 3, background: { r: 20, g: 160, b: 40 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    respond(buf);
    const p = (await extractMoviePagePalette("https://img.example/mixed.png"))!;
    const [r, g] = rgb(p.accent);
    expect(g).toBeGreaterThan(r);
  });
});
