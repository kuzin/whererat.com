/**
 * GET /api/cron/imdb-resync — bearer-secret gate in front of a catalog-wide
 * IMDb resync. The sync itself is mocked; we care about who can trigger it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/movie-imdb-sync", () => ({
  resyncAllCatalogMoviesFromImdb: vi.fn(),
}));

import * as route from "@/app/api/cron/imdb-resync/route";
import { GET } from "@/app/api/cron/imdb-resync/route";
import { revalidatePath } from "next/cache";
import { resyncAllCatalogMoviesFromImdb } from "@/lib/movie-imdb-sync";

const mockResync = vi.mocked(resyncAllCatalogMoviesFromImdb);
const mockRevalidate = vi.mocked(revalidatePath);

const SECRET = "s3cret-value-for-tests";
const ENV_KEYS = [
  "CRON_SECRET",
  "IMDB_CRON_SECRET",
  "CRON_SYNC_BUDGET_MS",
  "CRON_ALLOW_QUERY_SECRET",
] as const;
const saved: Record<string, string | undefined> = {};

function req(headers: Record<string, string> = {}, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/cron/imdb-resync${query}`, { headers });
}

const OK_RESULT = { total: 3, synced: 3, failed: 0 } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockRevalidate.mockReset();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CRON_SECRET = SECRET;
  mockResync.mockResolvedValue(OK_RESULT);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
});

describe("route config", () => {
  it("is dynamic, node runtime, with a long maxDuration", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
    expect(route.maxDuration).toBeGreaterThanOrEqual(60);
  });
});

describe("secret not configured", () => {
  it("503s when no secret is set and never runs the sync", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req({ authorization: "Bearer anything" }));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("503s for a whitespace-only secret (an empty secret must not match an empty bearer)", async () => {
    process.env.CRON_SECRET = "   ";
    const res = await GET(req({ authorization: "Bearer " }));
    expect(res.status).toBe(503);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("falls back to IMDB_CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    process.env.IMDB_CRON_SECRET = "alt-secret";
    const res = await GET(req({ authorization: "Bearer alt-secret" }));
    expect(res.status).toBe(200);
  });

  it("does not leak the secret in the 503 body", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });
});

describe("authorization", () => {
  it("401s with no credentials", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret of the same length", async () => {
    const wrong = "x".repeat(SECRET.length);
    const res = await GET(req({ authorization: `Bearer ${wrong}` }));
    expect(res.status).toBe(401);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("401s with a wrong secret of a different length (timing-safe compare must not throw)", async () => {
    for (const bad of ["short", SECRET + "x", SECRET.slice(0, -1)]) {
      const res = await GET(req({ authorization: `Bearer ${bad}` }));
      expect(res.status).toBe(401);
    }
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("401s for non-Bearer schemes and bare secrets", async () => {
    for (const authorization of [SECRET, `Basic ${SECRET}`, `Token ${SECRET}`, "Bearer", "Bearer   "]) {
      const res = await GET(req({ authorization }));
      expect(res.status).toBe(401);
    }
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("401s on an empty Authorization header", async () => {
    const res = await GET(req({ authorization: "" }));
    expect(res.status).toBe(401);
  });

  it("accepts the correct bearer secret (case-insensitive scheme, extra whitespace)", async () => {
    for (const authorization of [`Bearer ${SECRET}`, `bearer ${SECRET}`, `BEARER   ${SECRET}  `]) {
      mockResync.mockClear();
      const res = await GET(req({ authorization }));
      expect(res.status).toBe(200);
      expect(mockResync).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts X-Cron-Authorization as an alternative header", async () => {
    const res = await GET(req({ "x-cron-authorization": `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
  });

  it("a wrong Authorization does not block a correct X-Cron-Authorization, but wrong in both is 401", async () => {
    const ok = await GET(
      req({ authorization: "Bearer nope", "x-cron-authorization": `Bearer ${SECRET}` }),
    );
    expect(ok.status).toBe(200);
    const bad = await GET(
      req({ authorization: "Bearer nope", "x-cron-authorization": "Bearer nope2" }),
    );
    expect(bad.status).toBe(401);
  });

  it("does not accept ?secret= by default", async () => {
    const res = await GET(req({}, `?secret=${SECRET}`));
    expect(res.status).toBe(401);
    expect(mockResync).not.toHaveBeenCalled();
  });

  it("accepts ?secret= only when CRON_ALLOW_QUERY_SECRET=1", async () => {
    process.env.CRON_ALLOW_QUERY_SECRET = "1";
    expect((await GET(req({}, `?secret=${SECRET}`))).status).toBe(200);
    expect((await GET(req({}, "?secret=wrong"))).status).toBe(401);
    expect((await GET(req({}, "?secret="))).status).toBe(401);
  });

  it("CRON_ALLOW_QUERY_SECRET values other than '1' do not enable the query secret", async () => {
    for (const v of ["true", "0", "yes"]) {
      process.env.CRON_ALLOW_QUERY_SECRET = v;
      const res = await GET(req({}, `?secret=${SECRET}`));
      expect(res.status).toBe(401);
    }
  });

  it("uses the 'private, no-store' cache header on every response", async () => {
    const unauth = await GET(req());
    const ok = await GET(req({ authorization: `Bearer ${SECRET}` }));
    for (const r of [unauth, ok]) {
      expect(r.headers.get("Cache-Control")).toContain("no-store");
    }
  });
});

describe("method handling", () => {
  it("only exports GET (POST/PUT/DELETE are rejected by Next with 405)", () => {
    expect(typeof route.GET).toBe("function");
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((route as Record<string, unknown>)[m]).toBeUndefined();
    }
  });
});

describe("sync execution", () => {
  const auth = { authorization: `Bearer ${SECRET}` };

  it("returns the sync result with budget, seed, and timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
    const res = await GET(req(auth));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      total: 3,
      synced: 3,
      failed: 0,
      budgetMs: 8000,
      rotationSeed: Math.floor(Date.parse("2026-03-01T12:00:00.000Z") / 86400000),
      finishedAt: "2026-03-01T12:00:00.000Z",
    });
    expect(mockResync).toHaveBeenCalledWith({
      maxDurationMs: 8000,
      rotationSeed: body.rotationSeed,
    });
  });

  it("rotation seed changes day to day so successive runs cover different movies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const a = (await (await GET(req(auth))).json()).rotationSeed;
    vi.setSystemTime(new Date("2026-03-02T00:00:00Z"));
    const b = (await (await GET(req(auth))).json()).rotationSeed;
    expect(b).toBe(a + 1);
  });

  it.each([
    [undefined, 8000],
    ["abc", 8000],
    ["Infinity", 8000],
    ["2500", 2500],
    ["0", 0],
  ])("CRON_SYNC_BUDGET_MS=%j -> budget %s", async (raw, expected) => {
    if (raw !== undefined) process.env.CRON_SYNC_BUDGET_MS = raw;
    const res = await GET(req(auth));
    expect((await res.json()).budgetMs).toBe(expected);
    expect(mockResync.mock.calls[0]![0]!.maxDurationMs).toBe(expected);
  });

  it("a negative budget means unlimited", async () => {
    process.env.CRON_SYNC_BUDGET_MS = "-1";
    const res = await GET(req(auth));
    expect((await res.json()).budgetMs).toBe("unlimited");
    expect(mockResync.mock.calls[0]![0]!.maxDurationMs).toBeUndefined();
  });

  it("revalidates the home page and movie layout on success", async () => {
    await GET(req(auth));
    expect(mockRevalidate).toHaveBeenCalledWith("/");
    expect(mockRevalidate).toHaveBeenCalledWith("/movies/[slug]", "layout");
  });

  it("still succeeds if revalidatePath throws outside a request context", async () => {
    mockRevalidate.mockImplementation(() => {
      throw new Error("no request context");
    });
    const res = await GET(req(auth));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("500s with the error message when the sync throws, and skips revalidation", async () => {
    mockResync.mockRejectedValue(new Error("db down"));
    const res = await GET(req(auth));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "db down" });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("500s with a generic message when a non-Error is thrown", async () => {
    mockResync.mockRejectedValue("boom");
    const res = await GET(req(auth));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Resync failed");
  });
});
