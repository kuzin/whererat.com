import { isOffline } from "@/lib/offline";
import sharp from "sharp";

export type MoviePagePalette = {
  /** Poster area / panel wash mixed with neutrals */
  wash: string;
  /** Subtle sightings column wash */
  columnWash: string;
  /** Readable accent — chips, headings hints */
  accent: string;
  /** Hero radial / gradient wash */
  heroBloom: string;
};

export function deriveDarkMoviePagePalette(light: MoviePagePalette): MoviePagePalette {
  const parseHex = (h: string): [number, number, number] | null => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim());
    if (!m) return null;
    return [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)];
  };
  const washRgb = parseHex(light.wash) ?? [28, 24, 21];
  const colRgb = parseHex(light.columnWash) ?? [34, 29, 25];
  const accRgb = parseHex(light.accent) ?? [180, 83, 9];
  const bloomRgb = parseHex(light.heroBloom) ?? [20, 16, 13];
  return {
    wash: mixToward(washRgb, [17, 14, 12], 0.72),
    columnWash: mixToward(colRgb, [12, 10, 9], 0.78),
    accent: mixToward(accRgb, [214, 158, 46], 0.28),
    heroBloom: mixToward(bloomRgb, [8, 7, 6], 0.62),
  };
}

function clampByte(n: number) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")}`;
}

function mixToward(
  rgb: readonly [number, number, number],
  target: readonly [number, number, number],
  t: number,
) {
  return rgbToHex(
    rgb[0] + (target[0] - rgb[0]) * t,
    rgb[1] + (target[1] - rgb[1]) * t,
    rgb[2] + (target[2] - rgb[2]) * t,
  );
}

/** Build a full palette from a single accent hex color (e.g. from `overrideAccent`). */
export function buildPaletteFromAccent(accentHex: string): MoviePagePalette | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(accentHex.trim());
  if (!m) return null;
  const r = Number.parseInt(m[1], 16);
  const g = Number.parseInt(m[2], 16);
  const b = Number.parseInt(m[3], 16);
  const rgb: [number, number, number] = [r, g, b];
  const accent = `#${m[1].toLowerCase()}${m[2].toLowerCase()}${m[3].toLowerCase()}`;
  return {
    accent,
    wash: mixToward(rgb, [255, 249, 235], 0.68),
    columnWash: mixToward(rgb, [255, 253, 246], 0.78),
    heroBloom: mixToward(rgb, [15, 12, 10], 0.58),
  };
}

/** Weighted-ish dominant non-muted color ~32-pixel bucket grid */
function dominantFromRgb(rgb: Buffer, width: number, height: number) {
  const buckets = new Map<string, { r: number; g: number; b: number; w: number }>();

  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];

      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const chroma = mx === 0 ? 0 : (mx - mn) / mx;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luma > 246 || luma < 22 || chroma < 0.1) {
        continue;
      }

      const qr = clampByte(Math.floor(r / 36) * 36);
      const qg = clampByte(Math.floor(g / 36) * 36);
      const qb = clampByte(Math.floor(b / 36) * 36);
      const key = `${qr},${qg},${qb}`;

      const weight = chroma ** 2 * Math.min(luma / 220, 1);
      const cur = buckets.get(key) ?? {
        r: 0,
        g: 0,
        b: 0,
        w: 0,
      };

      cur.r += r * weight;
      cur.g += g * weight;
      cur.b += b * weight;
      cur.w += weight;
      buckets.set(key, cur);
    }
  }

  let pick: { r: number; g: number; b: number; w: number } | null = null;

  for (const v of buckets.values()) {
    if (!pick || v.w > pick.w) {
      pick = v;
    }
  }

  if (!pick || pick.w < 12) {
    return null;
  }

  const denom = Math.max(pick.w, 1);

  const rAvg = clampByte(pick.r / denom);
  const gAvg = clampByte(pick.g / denom);
  const bAvg = clampByte(pick.b / denom);
  const base: [number, number, number] = [rAvg, gAvg, bAvg];

  return {
    base,
    hex: rgbToHex(rAvg, gAvg, bAvg),
  };
}

export async function extractMoviePagePalette(
  imageUrl: string,
): Promise<MoviePagePalette | null> {
  // Hermetic runs (e2e) must not reach out to image hosts.
  if (isOffline()) return null;
  try {
    const buffer = Buffer.from(
      await (
        await fetch(imageUrl, {
          signal: AbortSignal.timeout(14000),
        })
      ).arrayBuffer(),
    );

    const { data, info } = await sharp(buffer)
      .resize(96, 96, { fit: "cover", position: "attention" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const dom = dominantFromRgb(data, info.width, info.height);

    if (!dom) {
      const { channels } = await sharp(buffer).stats();
      const r = channels?.[0]?.mean ?? 200;
      const g = channels?.[1]?.mean ?? 180;
      const b = channels?.[2]?.mean ?? 160;
      const fall: MoviePagePalette = {
        wash: mixToward([r, g, b], [255, 249, 235], 0.74),
        columnWash: mixToward([r, g, b], [253, 252, 247], 0.82),
        accent: rgbToHex(r * 0.85, g * 0.82, b * 0.78),
        heroBloom: mixToward([r, g, b], [12, 10, 9], 0.55),
      };
      return fall;
    }

    const { base } = dom;

    return {
      wash: mixToward(base, [255, 249, 235], 0.68),
      columnWash: mixToward(base, [255, 253, 246], 0.78),
      accent: rgbToHex(
        clampByte(base[0] * 0.92 + 22),
        clampByte(base[1] * 0.9 + 16),
        clampByte(base[2] * 0.86 + 8),
      ),
      heroBloom: mixToward(base, [15, 12, 10], 0.58),
    };
  } catch {
    return null;
  }
}
