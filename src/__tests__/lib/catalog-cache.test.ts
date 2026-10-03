/** Data-cache wrapper + invalidation: safe outside Next, honest about real errors. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  unstable_cache: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: h.unstable_cache,
  revalidateTag: h.revalidateTag,
}));

async function load() {
  vi.resetModules();
  return await import("@/lib/catalog-cache");
}

/** A cache that just runs the function, recording how it was configured. */
function passthroughCache() {
  h.unstable_cache.mockImplementation((fn: (...a: unknown[]) => unknown) => fn);
}

beforeEach(() => {
  h.unstable_cache.mockReset();
  h.revalidateTag.mockReset();
  delete process.env.WHERERAT_CATALOG_CACHE_SECONDS;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("cacheCatalogRead", () => {
  it("caches under a catalog-prefixed key, the catalog tag, and a 5 minute TTL by default", async () => {
    passthroughCache();
    const { cacheCatalogRead, CATALOG_CACHE_TAG } = await load();
    const read = cacheCatalogRead(async () => "value", ["thing"]);

    expect(await read()).toBe("value");
    const [, keyParts, options] = h.unstable_cache.mock.calls[0]!;
    expect(keyParts).toEqual(["catalog", "thing"]);
    expect(options).toEqual({ tags: [CATALOG_CACHE_TAG], revalidate: 300 });
  });

  it("forwards arguments to the wrapped function", async () => {
    passthroughCache();
    const { cacheCatalogRead } = await load();
    const read = cacheCatalogRead(async (a: number, b: number) => a + b, ["sum"]);
    expect(await read(2, 3)).toBe(5);
  });

  it("WHERERAT_CATALOG_CACHE_SECONDS sets the TTL", async () => {
    process.env.WHERERAT_CATALOG_CACHE_SECONDS = "45";
    passthroughCache();
    const { cacheCatalogRead } = await load();
    await cacheCatalogRead(async () => 1, ["x"])();
    expect(h.unstable_cache.mock.calls[0]![2]).toMatchObject({ revalidate: 45 });
  });

  it("a value of 0 disables caching entirely", async () => {
    process.env.WHERERAT_CATALOG_CACHE_SECONDS = "0";
    const fn = vi.fn(async () => "fresh");
    const { cacheCatalogRead } = await load();

    expect(await cacheCatalogRead(fn, ["x"])()).toBe("fresh");
    expect(h.unstable_cache).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(["abc", "-5", "NaN"])("an unusable TTL (%j) falls back to the default", async (value) => {
    process.env.WHERERAT_CATALOG_CACHE_SECONDS = value;
    passthroughCache();
    const { cacheCatalogRead } = await load();
    await cacheCatalogRead(async () => 1, ["x"])();
    expect(h.unstable_cache.mock.calls[0]![2]).toMatchObject({ revalidate: 300 });
  });

  it("serves the cached value without calling the function again", async () => {
    const fn = vi.fn(async () => "computed");
    h.unstable_cache.mockImplementation(() => async () => "from-cache");
    const { cacheCatalogRead } = await load();

    expect(await cacheCatalogRead(fn, ["x"])()).toBe("from-cache");
    expect(fn).not.toHaveBeenCalled();
  });

  it("an error from the wrapped function propagates and is NOT retried as a cache bypass", async () => {
    const fn = vi.fn(async () => {
      throw new Error("db down");
    });
    passthroughCache();
    const { cacheCatalogRead } = await load();

    await expect(cacheCatalogRead(fn, ["x"])()).rejects.toThrow("db down");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("outside a Next runtime (cache throws) it runs the function directly and warns once", async () => {
    h.unstable_cache.mockImplementation(() => {
      throw new Error("Invariant: incrementalCache missing in unstable_cache");
    });
    const fn = vi.fn(async () => "direct");
    const { cacheCatalogRead } = await load();
    const read = cacheCatalogRead(fn, ["x"]);

    expect(await read()).toBe("direct");
    expect(await read()).toBe("direct");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateCatalogCache", () => {
  it("expires the catalog tag immediately", async () => {
    const { invalidateCatalogCache, CATALOG_CACHE_TAG } = await load();
    invalidateCatalogCache();
    expect(h.revalidateTag).toHaveBeenCalledWith(CATALOG_CACHE_TAG, { expire: 0 });
  });

  it("never throws when there is no Next request to invalidate in (scripts, tests)", async () => {
    h.revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing in revalidateTag");
    });
    const { invalidateCatalogCache } = await load();
    expect(() => invalidateCatalogCache()).not.toThrow();
  });
});
