import { describe, it, expect, vi, afterEach } from "vitest";
import { createOptInToken, optInConfirmUrl, verifyOptInToken } from "@/lib/opt-in-token";
import { signForPurpose } from "@/lib/auth";

afterEach(() => vi.useRealTimers());

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

describe("opt-in confirmation token", () => {
  it("round-trips a (lower-cased, trimmed) address", () => {
    expect(verifyOptInToken(createOptInToken("  Alice@Example.COM "))).toBe("alice@example.com");
  });

  it("expires after 7 days", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const token = createOptInToken("a@x.io", t0);
    expect(verifyOptInToken(token, t0 + 6 * 86_400_000)).toBe("a@x.io");
    expect(verifyOptInToken(token, t0 + 7 * 86_400_000 + 5_000)).toBeUndefined();
  });

  it("rejects a tampered payload (can't swap in someone else's address)", () => {
    const [, sig] = createOptInToken("alice@x.io").split(".");
    const forged = `${b64({ e: "victim@x.io", x: 9_999_999_999 })}.${sig}`;
    expect(verifyOptInToken(forged)).toBeUndefined();
  });

  it("rejects a signature minted for a different purpose (e.g. a session cookie)", () => {
    const payload = b64({ e: "victim@x.io", x: 9_999_999_999 });
    expect(verifyOptInToken(`${payload}.${signForPurpose("other-purpose", payload)}`)).toBeUndefined();
  });

  it.each([undefined, "", ".", "abc", "a.b", "x".repeat(5000), "no-dot-at-all", `${b64({ e: 5, x: "y" })}.sig`])(
    "rejects junk %#",
    (t) => expect(verifyOptInToken(t as string | undefined)).toBeUndefined(),
  );

  it("rejects a correctly signed payload with the wrong shape", () => {
    for (const bad of [{ e: 5, x: 9_999_999_999 }, { e: "a@x.io" }, { e: "a@x.io", x: "soon" }, []]) {
      const payload = b64(bad);
      expect(verifyOptInToken(`${payload}.${signForPurpose("news-opt-in-v1", payload)}`)).toBeUndefined();
    }
  });

  it("builds a /confirm-subscription URL with an encoded token", () => {
    const url = optInConfirmUrl("https://whererat.com", "a@x.io");
    expect(url.startsWith("https://whererat.com/confirm-subscription?token=")).toBe(true);
    const token = decodeURIComponent(url.split("token=")[1]!);
    expect(verifyOptInToken(token)).toBe("a@x.io");
  });
});
