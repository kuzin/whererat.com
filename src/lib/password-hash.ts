import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "crypto";

/**
 * Password hashing with scrypt (Node built-in, no dependency).
 *
 * Stored format: `scrypt$N$r$p$<salt b64>$<hash b64>`. The cost parameters travel
 * with each hash, so they can be raised later and old hashes still verify (and
 * `needsRehash` tells the caller to upgrade them at the next login).
 */

// OWASP's scrypt guidance: N=2^16, r=8, p=2 (~64 MiB, ~100-200 ms).
const COST = { N: 65_536, r: 8, p: 2 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 256 * 1024 * 1024;
const PREFIX = "scrypt$";

/** Longer than any human password; stops a huge input from being used as a CPU/memory lever. */
export const MAX_PASSWORD_LENGTH = 200;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }, keyLength: number) {
  const options: ScryptOptions = { ...params, maxmem: MAX_MEMORY };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export function isPasswordHashed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError("Password must be between 1 and 200 characters.");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, KEY_LENGTH);
  return `${PREFIX}${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Equal-length digests so the comparison time doesn't reveal how much matched. */
function constantTimeStringEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Checks a password against a stored value. Accepts a scrypt hash, or — only so
 * existing accounts can still log in and be upgraded — a legacy plaintext value.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!password || password.length > MAX_PASSWORD_LENGTH || !stored) return false;

  if (!isPasswordHashed(stored)) return constantTimeStringEqual(password, stored);

  const [N, r, p, saltB64, hashB64] = stored.slice(PREFIX.length).split("$");
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (
    !saltB64 ||
    !hashB64 ||
    !Number.isInteger(params.N) ||
    !Number.isInteger(params.r) ||
    !Number.isInteger(params.p) ||
    params.N < 2 ||
    // A tampered row must not be able to request an absurd amount of memory.
    128 * params.N * params.r > MAX_MEMORY
  ) {
    return false;
  }
  try {
    const expected = Buffer.from(hashB64, "base64");
    if (expected.length === 0) return false;
    const actual = await derive(password, Buffer.from(saltB64, "base64"), params, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True for legacy plaintext values and for hashes made with weaker parameters. */
export function needsRehash(stored: string): boolean {
  if (!isPasswordHashed(stored)) return true;
  const [N, r, p] = stored.slice(PREFIX.length).split("$").map(Number);
  return N !== COST.N || r !== COST.r || p !== COST.p;
}

/** Burns the same CPU as a real check, so an unknown username isn't distinguishable by timing. */
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
  return false;
}
