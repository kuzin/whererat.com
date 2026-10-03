import { consumeSharedRateLimit } from "@/lib/rate-limit-store";

/**
 * One client, one bucket: lowercase, collapse IPv6 spellings ("::1" vs
 * "0:0:0:0:0:0:0:1") and unwrap IPv4-mapped addresses ("::ffff:1.2.3.4").
 */
export function canonicalizeClientIp(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "unknown";
  if (!trimmed.includes(":")) return trimmed;
  try {
    const host = new URL(`http://[${trimmed}]`).hostname.slice(1, -1);
    const mapped = host.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped?.[1]) return mapped[1];
    if (mapped?.[2] && mapped[3]) {
      const hi = Number.parseInt(mapped[2], 16);
      const lo = Number.parseInt(mapped[3], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return host;
  } catch {
    return trimmed;
  }
}

/** First hop of x-forwarded-for (Vercel overwrites it with the real client address). */
export function clientIpFromForwardedFor(header: string | null | undefined): string {
  const first = header?.split(",")[0]?.trim();
  return first ? canonicalizeClientIp(first) : "unknown";
}

type Bucket = { count: number; resetAt: number };
const memory = new Map<string, Bucket>();
const MAX_MEMORY_BUCKETS = 5_000;

function limitedInMemory(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (memory.size > MAX_MEMORY_BUCKETS) {
    for (const [k, b] of memory) if (b.resetAt <= now) memory.delete(k);
    if (memory.size > MAX_MEMORY_BUCKETS) memory.clear();
  }
  const bucket = memory.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

/**
 * Counts one hit and reports whether the caller is now over `max` within
 * `windowMs`. Uses the shared (Postgres) counter so it holds across serverless
 * instances, and a per-instance counter if the shared store is unavailable.
 */
export async function isRateLimited({
  key,
  max,
  windowMs,
}: {
  key: string;
  max: number;
  windowMs: number;
}): Promise<boolean> {
  const shared = await consumeSharedRateLimit({ key, max, windowMs });
  return shared ?? limitedInMemory(key, max, windowMs);
}
