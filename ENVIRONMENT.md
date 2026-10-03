# Environment variables

## Source of truth

**Vercel** (`Project → Settings → Environment Variables`) holds all secrets.  
**`.env.example`** is the canonical reference for what the app needs — keep it in sync when adding new vars.  
**`.env.local`** is your local copy — gitignored, never committed.

## Setting up locally

All app vars are set in all three Vercel environments (Production, Preview, Development), so you can use `vercel env pull`:

```bash
vercel env pull .env.local --environment=development
```

This will include `VERCEL_OIDC_TOKEN` noise from Vercel — you can delete that line. Alternatively, just copy `.env.example` → `.env.local` and fill values from the Vercel dashboard.

> **Note:** `vercel blob` CLI commands auto-run an env pull that overwrites `.env.local`. If that happens, run `vercel env pull .env.local --environment=development` to restore it.

## Variable reference

| Variable | Environments | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | Production, Preview | ✅ | Neon Postgres. Same DB for all environments. |
| `SESSION_SECRET` | Production, Preview | ✅ | HMAC key for session cookies. Rotate with `openssl rand -base64 48`. |
| `MODERATOR_ADMIN_PASSWORD` | Production, Preview | ✅ | Login password for `/login` (username: `admin`). |
| `CRON_SECRET` | Production, Preview | ✅ | Bearer token for `/api/cron/imdb-resync`. |
| `OMDB_API_KEY` | Production, Preview | Recommended | Movie search + metadata sync. Free at omdbapi.com. |
| `TMDB_READ_ACCESS_TOKEN` | Production, Preview | Recommended | Backdrop images. Free at themoviedb.org. |
| `BLOB_READ_WRITE_TOKEN` | Production, Preview | For uploads | Vercel Blob token. Without it, images write to local disk and are lost on deploy. |
| `RESEND_API_KEY` | Production, Preview | Optional | When set, emails the owner account on each new public submission. |
| `MODERATION_NOTIFY_FROM` | Production, Preview | Optional | Override the From address used for moderation emails. Default `WhereRat <no-reply@whererat.com>` — requires a verified sender domain in Resend. |
| `WHERERAT_CATALOG_CACHE_SECONDS` | Optional | Optional | Seconds the home page / `/api/v1/catalog` data stays cached (default `300`). Moderation actions expire it immediately; this TTL only covers writes made outside the app (scripts, manual SQL). `0` disables the cache. |
| `PG_POOL_MAX` | Optional | Optional | Max Postgres connections per server instance (default `10`). Lower it if the database connection limit is tight. |

## Adding a new variable

1. Add it to Vercel for Production and Preview: `vercel env add VAR_NAME production`
2. Add the documented entry to `.env.example` (no real value, just description)
3. Add the real value to your local `.env.local`

## Rotating a secret

```bash
# Generate a new secret
openssl rand -base64 48

# Update on Vercel (removes old, adds new)
vercel env rm SECRET_NAME production --yes
vercel env add SECRET_NAME production --value "<new-value>" --yes
vercel env rm SECRET_NAME preview --yes
vercel env add SECRET_NAME preview "" --value "<new-value>" --yes

# Update your local .env.local
```

## Setting up Vercel Blob (image uploads)

Sighting images require Vercel Blob to persist across deployments. Without it, images are written to Vercel's ephemeral filesystem and lost on each deploy.

1. Vercel dashboard → Project → **Storage** → **Create Store** → **Blob**
2. Name it `whererat-images` (or similar)
3. Copy the `BLOB_READ_WRITE_TOKEN` from the store's settings page
4. Add to Vercel: `vercel env add BLOB_READ_WRITE_TOKEN production --value "<token>" --yes`
5. Add to Vercel preview: `vercel env add BLOB_READ_WRITE_TOKEN preview "" --value "<token>" --yes`
6. Add to your `.env.local`

## Postgres connection

The app uses a single Neon database for all environments (local dev, Preview, Production). `src/lib/db.ts` tries these env var names in order:

1. `DATABASE_URL` ← preferred
2. `POSTGRES_URL`
3. `POSTGRES_PRISMA_URL`
4. `DATABASE_URL_UNPOOLED`

Use Neon's **pooled** connection string (the host contains `-pooler`) for `DATABASE_URL` on Vercel. Each function instance keeps its own `pg` pool, and the pooler keeps many instances from exhausting Postgres connections. Keep the unpooled string for `DATABASE_URL_UNPOOLED` / one-off scripts.

## Catalog cache

The home page and `/api/v1/catalog` read through Next's data cache (`src/lib/catalog-cache.ts`, tag `catalog`). Anything that changes what the catalog shows calls `invalidateCatalogCache()` — approvals, deletes, movie/sighting edits, IMDb resync via `updateMovieOverride`. Writes that bypass the app (a script, `psql`) show up after `WHERERAT_CATALOG_CACHE_SECONDS`. If you add a new write path for movies, sightings, or submissions, call `invalidateCatalogCache()` after it.
