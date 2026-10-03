import { Pool, type PoolClient } from "pg";

let sharedPool: Pool | undefined;

const PG_SSLMODE_ALIASES = new Set(["prefer", "require", "verify-ca"]);

/**
 * pg-connection-string warns that `prefer` / `require` / `verify-ca` aliases
 * will change semantics in pg v9. Keep current behavior explicit by upgrading
 * these values to `verify-full` at runtime.
 */
function normalizeSslMode(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const sslmode = parsed.searchParams.get("sslmode")?.toLowerCase();
    if (!sslmode) return connectionString;
    if (!PG_SSLMODE_ALIASES.has(sslmode)) return connectionString;
    if (parsed.searchParams.get("uselibpqcompat") === "true") {
      return connectionString;
    }
    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function resolveConnectionString(): string | undefined {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.DATABASE_URL_UNPOOLED,
  ];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed) return normalizeSslMode(trimmed);
  }
  return undefined;
}

function requireDatabaseUrl() {
  const url = resolveConnectionString();
  if (!url) {
    throw new Error(
      "Postgres connection string is missing. Set DATABASE_URL " +
        "(preferred), or POSTGRES_URL / POSTGRES_PRISMA_URL from Vercel Postgres or Neon. " +
        "Locally copy .env.example → .env.local (see README). On Vercel assign the var to " +
        "Production and Preview, then redeploy.",
    );
  }
  return url;
}

export function getDbPool() {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: requireDatabaseUrl(),
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return sharedPool;
}

/**
 * Runs `fn` on one pooled connection inside BEGIN/COMMIT, rolling back if it
 * throws, so multi-statement writes (status + images + audit row) land together
 * or not at all.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDbPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The original error is the one worth surfacing.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDbPool() {
  if (!sharedPool) return;
  await sharedPool.end();
  sharedPool = undefined;
}
