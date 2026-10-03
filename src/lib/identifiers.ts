/**
 * Identifiers that arrive in URLs (slugs, tokens) are checked before they reach SQL.
 * Postgres rejects NUL bytes in text parameters with an error, which would surface as a 500
 * for a request that should simply not match anything.
 */

/** Movie/show slugs: letters, digits, `_`, `.`, `~`, `-`, at most 200 characters. */
export function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && /^[\w.~-]{1,200}$/.test(value);
}

/** Opaque tokens (unsubscribe links, …): printable, no NUL or control characters, bounded. */
export function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}
