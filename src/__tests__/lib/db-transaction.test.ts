import { describe, it, expect, vi, beforeEach } from "vitest";

const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://fake@localhost/fake";
});
vi.mock("pg", () => ({
  Pool: class {
    connect = async () => client;
  },
}));

import { withTransaction } from "@/lib/db";

const verbs = () => client.query.mock.calls.map((c) => String(c[0]).toLowerCase());

beforeEach(() => {
  client.query.mockReset().mockResolvedValue({ rows: [] });
  client.release.mockReset();
});

describe("withTransaction", () => {
  it("commits and returns the callback's value", async () => {
    await expect(withTransaction(async () => 42)).resolves.toBe(42);
    expect(verbs()).toEqual(["begin", "commit"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and rethrows the original error", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(verbs()).toEqual(["begin", "rollback"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the original error when ROLLBACK itself fails", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (String(sql).toLowerCase() === "rollback") throw new Error("connection lost");
      return { rows: [] };
    });
    await expect(
      withTransaction(async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back when COMMIT fails and always releases the client", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (String(sql).toLowerCase() === "commit") throw new Error("serialization failure");
      return { rows: [] };
    });
    await expect(withTransaction(async () => 1)).rejects.toThrow("serialization failure");
    expect(verbs()).toEqual(["begin", "commit", "rollback"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
