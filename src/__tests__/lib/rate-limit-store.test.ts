import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDbPool: () => ({ query }) }));

// The global setup stubs this module; here we want the real one.
const { consumeSharedRateLimit, resetRateLimitStoreWarning } = await vi.importActual<
  typeof import("@/lib/rate-limit-store")
>("@/lib/rate-limit-store");

const opts = { key: "submit:1.2.3.4", max: 5, windowMs: 3_600_000 };

beforeEach(() => {
  query.mockReset();
  resetRateLimitStoreWarning();
  vi.spyOn(console, "warn").mockImplementation(() => {}).mockClear();
});

describe("consumeSharedRateLimit", () => {
  it.each([
    [1, false],
    [5, false],
    [6, true],
    [500, true],
  ])("count %i -> over limit: %s", async (count, blocked) => {
    query.mockResolvedValueOnce({ rows: [{ count }] });
    expect(await consumeSharedRateLimit(opts)).toBe(blocked);
  });

  it("does the whole check in one parameterized upsert (atomic across instances)", async () => {
    query.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    await consumeSharedRateLimit({ ...opts, key: "x'; drop table rate_limits;--" });
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/insert into rate_limits[\s\S]*on conflict \(key\) do update/i);
    expect(sql).not.toContain("drop table");
    expect(params).toEqual(["x'; drop table rate_limits;--", 3_600_000]);
  });

  it("returns undefined (use the in-memory fallback) when the table is missing", async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('relation "rate_limits" does not exist'), { code: "42P01" }));
    expect(await consumeSharedRateLimit(opts)).toBeUndefined();
  });

  it("returns undefined when the DB itself is unreachable, and warns only once", async () => {
    query.mockRejectedValue(new Error("connection refused"));
    expect(await consumeSharedRateLimit(opts)).toBeUndefined();
    expect(await consumeSharedRateLimit(opts)).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for an unusable count instead of guessing", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await consumeSharedRateLimit(opts)).toBeUndefined();
  });
});
