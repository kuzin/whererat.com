import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ getDbPool: () => ({ query }) }));

import {
  upsertMarketingOptIn,
  getMarketingSubscribers,
  getSubscriber,
  unsubscribeByToken,
} from "@/lib/email-preferences-store";

beforeEach(() => {
  query.mockReset();
});

describe("upsertMarketingOptIn", () => {
  it("upserts with the email as the only (parameterised) value", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await upsertMarketingOptIn("a@b.co");
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual(["a@b.co"]);
    expect(sql).toMatch(/INSERT INTO email_preferences/);
    expect(sql).toMatch(/ON CONFLICT \(email\) DO UPDATE/);
    expect(sql).toContain("$1");
    expect(sql).not.toContain("a@b.co");
  });

  it("is idempotent: repeated calls issue the same upsert and don't throw", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await upsertMarketingOptIn("a@b.co");
    await upsertMarketingOptIn("a@b.co");
    expect(query.mock.calls[0]).toEqual(query.mock.calls[1]);
  });

  it("passes SQL-injection-looking input as a bound param, not text", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    const evil = "x'); DROP TABLE email_preferences;--";
    await upsertMarketingOptIn(evil);
    expect(query.mock.calls[0]![1]).toEqual([evil]);
    expect(query.mock.calls[0]![0]).not.toContain("DROP");
  });

  it("propagates DB errors", async () => {
    query.mockRejectedValue(new Error("down"));
    await expect(upsertMarketingOptIn("a@b.co")).rejects.toThrow("down");
  });
});

describe("getMarketingSubscribers", () => {
  it("maps snake_case rows and only selects opted-in", async () => {
    query.mockResolvedValue({
      rows: [
        { email: "a@b.co", unsubscribe_token: "t1" },
        { email: "c@d.co", unsubscribe_token: "t2" },
      ],
    });
    const out = await getMarketingSubscribers();
    expect(out).toEqual([
      { email: "a@b.co", unsubscribeToken: "t1" },
      { email: "c@d.co", unsubscribeToken: "t2" },
    ]);
    expect(query.mock.calls[0]![0]).toMatch(/marketing_opt_in = true/);
  });

  it("returns [] when nobody is subscribed", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getMarketingSubscribers()).toEqual([]);
  });
});

describe("getSubscriber", () => {
  it("returns undefined when not found / not opted in", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getSubscriber("none@x.co")).toBeUndefined();
    expect(query.mock.calls[0]![1]).toEqual(["none@x.co"]);
    expect(query.mock.calls[0]![0]).toMatch(/marketing_opt_in = true/);
  });

  it("returns the mapped subscriber", async () => {
    query.mockResolvedValue({ rows: [{ email: "a@b.co", unsubscribe_token: "tok" }] });
    expect(await getSubscriber("a@b.co")).toEqual({ email: "a@b.co", unsubscribeToken: "tok" });
  });
});

describe("unsubscribeByToken", () => {
  it("returns true when a row was updated", async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect(await unsubscribeByToken("tok")).toBe(true);
    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual(["tok"]);
    expect(sql).toMatch(/SET marketing_opt_in = false/);
    expect(sql).toMatch(/unsubscribe_token = \$1 AND marketing_opt_in = true/);
  });

  it("returns false when nothing matched (unknown or already-used token)", async () => {
    query.mockResolvedValue({ rowCount: 0 });
    expect(await unsubscribeByToken("tok")).toBe(false);
  });

  it("treats a null rowCount as no match", async () => {
    query.mockResolvedValue({ rowCount: null });
    expect(await unsubscribeByToken("tok")).toBe(false);
  });

  it("second call with the same token is false (idempotent unsubscribe)", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    expect(await unsubscribeByToken("tok")).toBe(true);
    expect(await unsubscribeByToken("tok")).toBe(false);
  });
});
