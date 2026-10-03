import { getDbPool } from "@/lib/db";

let warnedUnavailable = false;

/**
 * Counts one hit for `key` in a fixed window shared by every server instance
 * (a Postgres row), so the limit holds on serverless where each instance would
 * otherwise keep its own in-memory counter.
 *
 * @returns `true` when the caller is over the limit, `false` when allowed, and
 * `undefined` when the shared store can't be used (table not created yet, DB
 * down) so the caller can fall back to its per-instance limiter instead of
 * failing the request.
 */
export async function consumeSharedRateLimit({
  key,
  max,
  windowMs,
}: {
  key: string;
  max: number;
  windowMs: number;
}): Promise<boolean | undefined> {
  try {
    const pool = getDbPool();
    // One atomic statement: start a new window if the old one ended, else count up.
    const result = await pool.query<{ count: number }>(
      `insert into rate_limits (key, count, reset_at)
       values ($1, 1, now() + ($2 * interval '1 millisecond'))
       on conflict (key) do update
         set count = case when rate_limits.reset_at <= now() then 1 else rate_limits.count + 1 end,
             reset_at = case when rate_limits.reset_at <= now()
                             then now() + ($2 * interval '1 millisecond')
                             else rate_limits.reset_at end
       returning count`,
      [key, windowMs],
    );
    const count = Number(result.rows[0]?.count);
    if (!Number.isFinite(count)) return undefined;

    // Opportunistic cleanup so the table doesn't grow forever.
    if (Math.random() < 0.02) void purgeExpired();
    return count > max;
  } catch (error) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        "[rate-limit] shared store unavailable, using per-instance limits. " +
          "Apply the rate_limits table from db/schema.sql.",
        error instanceof Error ? error.message : error,
      );
    }
    return undefined;
  }
}

async function purgeExpired() {
  try {
    await getDbPool().query(`delete from rate_limits where reset_at < now() - interval '1 day'`);
  } catch {
    // Housekeeping only; never affects a request.
  }
}

/** Test hook: lets the "unavailable" warning fire again. */
export function resetRateLimitStoreWarning() {
  warnedUnavailable = false;
}
