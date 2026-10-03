import { revalidateTag, unstable_cache } from "next/cache";

/** Tag on every cached catalog read; {@link invalidateCatalogCache} expires them all. */
export const CATALOG_CACHE_TAG = "catalog";

const DEFAULT_TTL_SECONDS = 300;

let warnedBypass = false;

/**
 * Seconds a cached catalog read stays fresh. `WHERERAT_CATALOG_CACHE_SECONDS=0` turns the
 * cache off (the e2e suite seeds the database directly, bypassing invalidation).
 *
 * This TTL is the backstop for writes that don't go through the app — one-off scripts
 * (`yarn imdb:resync`) and manual SQL — which can't call `revalidateTag`.
 */
function ttlSeconds(): number {
  const raw = process.env.WHERERAT_CATALOG_CACHE_SECONDS?.trim();
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TTL_SECONDS;
}

/**
 * Wraps a read in Next's data cache (shared across requests and instances). Results must be
 * JSON-serialisable — no Maps/Sets/Dates — and under the 2 MB per-entry limit, so cache
 * slim, derived data rather than raw rows.
 *
 * Falls back to calling `fn` directly when there is no cache to use (cache disabled, or
 * running outside a Next request such as unit tests and tsx scripts). An error thrown by
 * `fn` itself always propagates.
 */
export function cacheCatalogRead<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts: string[],
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const ttl = ttlSeconds();
    if (ttl === 0) return fn(...args);

    let failure: { error: unknown } | undefined;
    try {
      const cached = unstable_cache(
        async (...inner: A) => {
          try {
            return await fn(...inner);
          } catch (error) {
            failure = { error };
            throw error;
          }
        },
        ["catalog", ...keyParts],
        { tags: [CATALOG_CACHE_TAG], revalidate: ttl },
      );
      return await cached(...args);
    } catch (error) {
      if (failure) throw failure.error;
      // No usable cache in this context; serve uncached rather than fail the request.
      if (!warnedBypass) {
        warnedBypass = true;
        console.warn("[catalog-cache] bypassing cache:", error instanceof Error ? error.message : error);
      }
      return fn(...args);
    }
  };
}

/**
 * Call after any write that changes what the public catalog shows (movies, sightings,
 * approved submissions, overrides). Expires immediately so the next read is fresh. Outside a
 * Next request (scripts, unit tests) there is nothing to invalidate and the TTL applies.
 */
export function invalidateCatalogCache(): void {
  try {
    revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
  } catch {
    // Not inside a Next request/action — the TTL backstop covers it.
  }
}
