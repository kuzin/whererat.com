import { timingSafeEqual } from "crypto";
import { signForPurpose } from "@/lib/auth";

const PURPOSE = "news-opt-in-v1";
const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Stateless confirmation token for the news opt-in: the address is only stored
 * once its owner clicks the link we e-mailed, so nobody can subscribe someone
 * else's address by typing it into the submit form.
 */
export function createOptInToken(email: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ e: email.trim().toLowerCase(), x: Math.floor(now / 1000) + TTL_SECONDS }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${signForPurpose(PURPOSE, payload)}`;
}

/** @returns the confirmed address, or undefined for a bad / tampered / expired token. */
export function verifyOptInToken(token: string | undefined, now = Date.now()): string | undefined {
  if (!token || token.length > 2_000) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return undefined;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(signForPurpose(PURPOSE, payload), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      e?: unknown;
      x?: unknown;
    };
    if (typeof parsed.e !== "string" || typeof parsed.x !== "number") return undefined;
    if (parsed.x < Math.floor(now / 1000)) return undefined;
    return parsed.e;
  } catch {
    return undefined;
  }
}

export function optInConfirmUrl(baseUrl: string, email: string): string {
  return `${baseUrl}/confirm-subscription?token=${encodeURIComponent(createOptInToken(email))}`;
}
