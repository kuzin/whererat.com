/** getDbPool: one shared Pool, built with explicit limits and timeouts. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: Record<string, unknown>) {
      h.options.push(options);
    }
  },
}));

async function load() {
  vi.resetModules();
  return await import("@/lib/db");
}

beforeEach(() => {
  h.options = [];
  process.env.DATABASE_URL = "postgres://fake@localhost/fake";
  delete process.env.PG_POOL_MAX;
});

describe("getDbPool", () => {
  it("builds one pool and reuses it", async () => {
    const { getDbPool } = await load();
    expect(getDbPool()).toBe(getDbPool());
    expect(h.options).toHaveLength(1);
  });

  it("fails fast on a stuck connect instead of waiting forever (pg's default)", async () => {
    const { getDbPool } = await load();
    getDbPool();
    expect(h.options[0]).toMatchObject({
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
    });
  });

  it("caps connections at 10 by default", async () => {
    const { getDbPool } = await load();
    getDbPool();
    expect(h.options[0]!.max).toBe(10);
  });

  it("PG_POOL_MAX overrides the cap", async () => {
    process.env.PG_POOL_MAX = "3";
    const { getDbPool } = await load();
    getDbPool();
    expect(h.options[0]!.max).toBe(3);
  });

  it.each(["0", "-2", "abc", ""])("ignores an unusable PG_POOL_MAX (%j)", async (value) => {
    process.env.PG_POOL_MAX = value;
    const { getDbPool } = await load();
    getDbPool();
    expect(h.options[0]!.max).toBe(10);
  });
});
