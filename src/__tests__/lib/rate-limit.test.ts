import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { canonicalizeClientIp, clientIpFromForwardedFor, isRateLimited } from "@/lib/rate-limit";
import { consumeSharedRateLimit } from "@/lib/rate-limit-store";

const mockShared = vi.mocked(consumeSharedRateLimit);

beforeEach(() => mockShared.mockReset().mockResolvedValue(undefined));
afterEach(() => vi.useRealTimers());

describe("canonicalizeClientIp", () => {
  it.each([
    ["1.2.3.4", "1.2.3.4"],
    ["  1.2.3.4 ", "1.2.3.4"],
    ["", "unknown"],
    ["   ", "unknown"],
    ["::FFFF:1.2.3.4", "1.2.3.4"],
    ["::ffff:0102:0304", "1.2.3.4"],
    ["2001:DB8::1", "2001:db8::1"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
  ])("%j -> %j", (raw, expected) => expect(canonicalizeClientIp(raw)).toBe(expected));

  it("never throws on junk", () => {
    for (const junk of ["not an ip", ":::::", "[::1]", "1.2.3.4:80:90", "\u0000", "x".repeat(10_000)]) {
      expect(() => canonicalizeClientIp(junk)).not.toThrow();
    }
  });
});

describe("clientIpFromForwardedFor", () => {
  it("takes the first hop", () => expect(clientIpFromForwardedFor("9.9.9.9, 10.0.0.1")).toBe("9.9.9.9"));
  it.each([null, undefined, "", " , "])("missing header %j -> unknown", (v) =>
    expect(clientIpFromForwardedFor(v)).toBe("unknown"),
  );
});

describe("isRateLimited", () => {
  const opts = (key: string) => ({ key, max: 3, windowMs: 60_000 });

  it("trusts the shared limiter when it answers", async () => {
    mockShared.mockResolvedValueOnce(true);
    expect(await isRateLimited(opts("k-shared-1"))).toBe(true);
    mockShared.mockResolvedValueOnce(false);
    expect(await isRateLimited(opts("k-shared-2"))).toBe(false);
  });

  it("falls back to a per-instance counter when the shared store is unavailable", async () => {
    const key = `k-mem-${Math.random()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await isRateLimited(opts(key)));
    expect(results).toEqual([false, false, false, true, true]);
  });

  it("the fallback window resets", async () => {
    vi.useFakeTimers();
    const key = `k-reset-${Math.random()}`;
    for (let i = 0; i < 4; i++) await isRateLimited(opts(key));
    expect(await isRateLimited(opts(key))).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(await isRateLimited(opts(key))).toBe(false);
  });

  it("keys are independent", async () => {
    const a = `k-a-${Math.random()}`;
    for (let i = 0; i < 5; i++) await isRateLimited(opts(a));
    expect(await isRateLimited(opts(`k-b-${Math.random()}`))).toBe(false);
  });

  it("does not let the in-memory map grow without bound", async () => {
    for (let i = 0; i < 6_000; i++) await isRateLimited({ key: `flood-${i}`, max: 1, windowMs: 60_000 });
    // Still functional afterwards.
    expect(await isRateLimited(opts(`after-flood-${Math.random()}`))).toBe(false);
  });
});
