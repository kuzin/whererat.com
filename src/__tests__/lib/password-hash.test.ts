import { describe, it, expect, vi } from "vitest";

// Real scrypt (64 MiB, ~100-200 ms each) with several hashes per test: give it room
// when the machine is busy (e.g. under coverage instrumentation).
vi.setConfig({ testTimeout: 30_000 });
import {
  MAX_PASSWORD_LENGTH,
  hashPassword,
  isPasswordHashed,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from "@/lib/password-hash";

// scrypt at production cost is intentionally slow; share a couple of hashes.
const PW = "correct horse battery staple";
let hash: string;
const getHash = async () => (hash ??= await hashPassword(PW));

describe("hashPassword", () => {
  it("produces a self-describing scrypt hash with the cost parameters", async () => {
    const h = await getHash();
    expect(h).toMatch(/^scrypt\$65536\$8\$2\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(isPasswordHashed(h)).toBe(true);
  });

  it("never contains the password", async () => {
    expect(await getHash()).not.toContain(PW);
  });

  it("uses a fresh random salt: same password, different hashes, both verify", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it.each(["", "x".repeat(MAX_PASSWORD_LENGTH + 1)])("rejects an empty / over-long password (%#)", async (pw) => {
    await expect(hashPassword(pw)).rejects.toThrow(RangeError);
  });

  it("accepts the maximum length", async () => {
    const pw = "y".repeat(MAX_PASSWORD_LENGTH);
    expect(await verifyPassword(pw, await hashPassword(pw))).toBe(true);
  });

  it("handles unicode and treats canonically-equivalent forms as the same password", async () => {
    const composed = "pässwörd🐀"; // ä, ö precomposed
    const decomposed = composed.normalize("NFD");
    const h = await hashPassword(composed);
    expect(await verifyPassword(decomposed, h)).toBe(true);
    expect(await verifyPassword("passwörd🐀", h)).toBe(false);
  });
});

describe("verifyPassword (hashed)", () => {
  it("accepts the right password", async () => {
    expect(await verifyPassword(PW, await getHash())).toBe(true);
  });

  it.each([
    "wrong",
    "Correct horse battery staple",
    `${PW} `,
    ` ${PW}`,
    PW.slice(0, -1),
    "",
    "x".repeat(MAX_PASSWORD_LENGTH + 1),
  ])("rejects %j", async (attempt) => {
    expect(await verifyPassword(attempt, await getHash())).toBe(false);
  });

  it("rejects a hash whose digest was tampered with", async () => {
    const h = await getHash();
    const parts = h.split("$");
    const digest = Buffer.from(parts[5]!, "base64");
    digest[0] = digest[0]! ^ 0xff;
    parts[5] = digest.toString("base64");
    expect(await verifyPassword(PW, parts.join("$"))).toBe(false);
  });

  it("rejects a hash with a swapped salt", async () => {
    const other = (await hashPassword("other")).split("$")[4]!;
    const parts = (await getHash()).split("$");
    parts[4] = other;
    expect(await verifyPassword(PW, parts.join("$"))).toBe(false);
  });

  it.each([
    "scrypt$",
    "scrypt$$$$$",
    "scrypt$abc$8$2$c2FsdA==$aGFzaA==",
    "scrypt$65536$8$2$c2FsdA==", // missing digest
    "scrypt$65536$8$2$$aGFzaA==", // missing salt
    "scrypt$0$8$2$c2FsdA==$aGFzaA==",
    "scrypt$65536$8$2$c2FsdA==$",
  ])("fails closed on a malformed stored value %#", async (stored) => {
    expect(await verifyPassword(PW, stored)).toBe(false);
  });

  it("refuses a stored row that asks for an absurd amount of memory (no DoS lever)", async () => {
    const start = Date.now();
    expect(await verifyPassword(PW, "scrypt$1073741824$8$1$c2FsdA==$aGFzaA==")).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("an empty stored value never matches an empty password", async () => {
    expect(await verifyPassword("", "")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("verifyPassword (legacy plaintext, accepted only so accounts can be upgraded)", () => {
  it("matches an identical plaintext value", async () => {
    expect(await verifyPassword("hunter2hunter2", "hunter2hunter2")).toBe(true);
  });

  it.each(["hunter2hunter3", "HUNTER2HUNTER2", "hunter2hunter2 ", "", "hunter2"])("rejects %j", async (attempt) => {
    expect(await verifyPassword(attempt, "hunter2hunter2")).toBe(false);
  });

  it("a plaintext password that merely STARTS with 'scrypt$' is not mistaken for a hash that verifies", async () => {
    // It is treated as a (malformed) hash, so the literal password does not log in.
    expect(await verifyPassword("scrypt$my-password", "scrypt$my-password")).toBe(false);
  });
});

describe("needsRehash", () => {
  it("flags legacy plaintext", () => expect(needsRehash("hunter2hunter2")).toBe(true));
  it("flags a hash with weaker parameters", () =>
    expect(needsRehash("scrypt$16384$8$1$c2FsdA==$aGFzaA==")).toBe(true));
  it("does not flag a current hash", async () => expect(needsRehash(await getHash())).toBe(false));
});

describe("verifyAgainstDummy", () => {
  it("always returns false but spends real hashing time (unknown-user timing)", async () => {
    await verifyAgainstDummy("warm-up"); // build the dummy hash once
    const start = performance.now();
    expect(await verifyAgainstDummy("anything")).toBe(false);
    expect(performance.now() - start).toBeGreaterThan(20);
  });
});
