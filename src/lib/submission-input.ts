/**
 * Hardening for public sighting submissions. Everything a visitor can post flows
 * through these helpers before it reaches the DB or an `<Image src>`.
 */
import { OTHER_RODENT_ID, RODENT_TYPE_OPTIONS } from "@/lib/whererat";

export const SUBMISSION_LIMITS = {
  movieTitle: 200,
  sightingTitle: 200,
  episodeTitle: 200,
  submitterName: 100,
  description: 10_000,
  timestamp: 32,
  posterUrl: 2_048,
  contentWarning: 200,
  contentWarnings: 20,
} as const;

/** Postgres `integer` ceiling; season/episode numbers beyond this error in the DB. */
const INT4_MAX = 2_147_483_647;
/** Matches the `movies.release_year` check constraint (> 1800 and < 3000). */
export const MIN_RELEASE_YEAR = 1801;
export const MAX_RELEASE_YEAR = 2999;

// NUL is rejected by Postgres text columns; the rest render as nothing but defeat
// "required field" checks (`"​".trim()` is not empty).
const INVISIBLE_RE = /[\u0000​-‍⁠﻿]/g;

/**
 * Trim, drop NUL / zero-width characters, and cap length by code point (so an
 * emoji is never split in half). Non-string values (e.g. a `File` part sent in
 * a text field) become "".
 */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const stripped = value.replace(INVISIBLE_RE, "").trim();
  const chars = Array.from(stripped);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("").trim() : stripped;
}

/** Strict integer parse: "12" ok; "12.5", "1e3", "abc", "" → undefined. */
export function parseStrictInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "string" || !/^\s*-?\d{1,15}\s*$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

export function parseReleaseYear(value: unknown): number | undefined {
  return parseStrictInt(value, MIN_RELEASE_YEAR, MAX_RELEASE_YEAR);
}

/** Season / episode numbers: positive and small enough for a Postgres integer. */
export function parseSeasonOrEpisode(value: unknown): number | undefined {
  // "2.9" has always meant season 2 here; keep that, but only for plain decimals.
  const whole = typeof value === "string" ? value.trim().match(/^(\d{1,15})(?:\.\d+)?$/)?.[1] : undefined;
  return parseStrictInt(whole ?? value, 1, INT4_MAX);
}

/**
 * Timestamps are a percentage ("42%") or a clock position ("1:02:03" / "42:00").
 * Anything else is rejected rather than stored unparsable.
 */
export function isValidTimestamp(value: string): boolean {
  if (/^\d{1,3}%$/.test(value)) return Number.parseInt(value, 10) <= 100;
  return /^\d{1,2}(:[0-5]?\d){1,2}$/.test(value);
}

const KNOWN_RODENT_IDS = new Set<string>([...RODENT_TYPE_OPTIONS.map((r) => r.id), OTHER_RODENT_ID]);

/** Known ids only, de-duplicated, order preserved. */
export function cleanRodentTypes(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const id = typeof v === "string" ? v.trim() : "";
    if (KNOWN_RODENT_IDS.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function cleanContentWarnings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const warning = cleanText(v, SUBMISSION_LIMITS.contentWarning);
    if (warning && !out.includes(warning)) out.push(warning);
    if (out.length >= SUBMISSION_LIMITS.contentWarnings) break;
  }
  return out;
}

// Mirrors `images.remotePatterns` in next.config.ts. A poster on any other host
// can't be rendered by next/image, so it would show as a broken image.
const ALLOWED_IMAGE_HOSTS = new Set([
  "placehold.co",
  "image.tmdb.org",
  "m.media-amazon.com",
  "images.unsplash.com",
  "i.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "where-rat.s3.us-east-1.amazonaws.com",
]);

function s3PublicHostname(): string | undefined {
  const base = process.env.S3_PUBLIC_BASE_URL?.trim();
  if (!base) return undefined;
  try {
    return new URL(base).hostname;
  } catch {
    return undefined;
  }
}

/** `https:` URL on a host our image config can render; anything else is dropped. */
export function sanitizeRemoteImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.length > SUBMISSION_LIMITS.posterUrl) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const allowed =
    ALLOWED_IMAGE_HOSTS.has(host) ||
    host.endsWith(".public.blob.vercel-storage.com") ||
    host === s3PublicHostname();
  return allowed ? url.toString() : undefined;
}

/** Poster: a site-relative path (single leading slash) or an allowed remote image. */
export function sanitizePosterUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (/^\/(?![/\\])[^\s]*$/.test(raw) && raw.length <= SUBMISSION_LIMITS.posterUrl) return raw;
  return sanitizeRemoteImageUrl(raw);
}

/**
 * URL of an image this app stored itself (local disk or Vercel Blob / S3). The
 * public form only ever sends files; a client-supplied URL must be one of ours.
 */
export function isOwnStorageUrl(value: string): boolean {
  if (/^\/uploads\/(sightings|avatars)\/[\w.-]+$/.test(value) && !value.includes("..")) return true;
  const remote = sanitizeRemoteImageUrl(value);
  if (!remote) return false;
  const host = new URL(remote).hostname.toLowerCase();
  return host.endsWith(".public.blob.vercel-storage.com") || host === s3PublicHostname();
}

/** Same-site relative path only (blocks `https://…`, `//host`, `/\host`, `javascript:`). */
export function safeReturnTo(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^\/(?![/\\])/.test(raw) ? raw : fallback;
}
