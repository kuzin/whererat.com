# Postgres

## Files

- `schema.sql`: relational schema for movies, sightings, submissions, moderation, and accounts.

## Apply schema

```bash
yarn db:schema:apply
```

Requires `DATABASE_URL` to be set.

## Runtime check

Once running with `DATABASE_URL`:

- `GET /api/health/db`

## Applying schema changes

There is no migration runner; `schema.sql` is idempotent, so re-running it is safe. The newest addition is a partial index for the public catalog's approved-submissions read:

```sql
create index if not exists submissions_approved_idx
  on submissions(id) where status = 'approved';
```
