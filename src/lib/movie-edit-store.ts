import type { Movie } from "@/lib/whererat";
import { getDbPool } from "@/lib/db";
import { invalidateCatalogCache } from "@/lib/catalog-cache";

export async function getMovieOverride(movieId: string) {
  const pool = getDbPool();
  const result = await pool.query<{ override: Partial<Movie> }>(
    `select override from movie_overrides where movie_id = $1`,
    [movieId],
  );
  return result.rows[0]?.override;
}

export function applyMovieOverride(movie: Movie, override: Partial<Movie> | undefined): Movie {
  if (!override) return movie;
  return {
    ...movie,
    ...override,
    metadata: {
      ...movie.metadata,
      ...(override.metadata ?? {}),
    },
  };
}

export async function updateMovieOverride(movieId: string, override: Partial<Movie>) {
  const pool = getDbPool();
  await pool.query(
    `insert into movie_overrides (movie_id, override, updated_at)
     values ($1,$2,now())
     on conflict (movie_id) do update
       set override = excluded.override,
           updated_at = now()`,
    [movieId, override],
  );
  await pool.query(
    `update movies
        set title = coalesce($2, title),
            release_year = coalesce($3, release_year),
            runtime_minutes = coalesce($4, runtime_minutes),
            genres = coalesce($5, genres),
            poster_tone = coalesce($6, poster_tone),
            poster_url = coalesce($7, poster_url),
            backdrop_url = coalesce($8, backdrop_url),
            poster_alt = coalesce($9, poster_alt),
            summary = coalesce($10, summary),
            metadata = case
              when $11::jsonb is null then metadata
              else metadata || $11::jsonb
            end,
            updated_at = now()
      where id = $1`,
    [
      movieId,
      override.title ?? null,
      override.releaseYear ?? null,
      override.runtimeMinutes ?? null,
      override.genres ?? null,
      override.posterTone ?? null,
      override.posterUrl ?? null,
      override.backdropUrl ?? null,
      override.posterAlt ?? null,
      override.summary ?? null,
      override.metadata ?? null,
    ],
  );
  invalidateCatalogCache();
}

export async function clearMovieOverride(movieId: string) {
  const pool = getDbPool();
  await pool.query(`delete from movie_overrides where movie_id = $1`, [movieId]);
}

export async function getDeletedMovieIds() {
  const pool = getDbPool();
  const result = await pool.query<{ id: string }>(
    `select id from movies where is_deleted = true`,
  );
  return new Set(result.rows.map((row) => row.id));
}

export async function deleteMovieById(movieId: string) {
  const pool = getDbPool();
  await pool.query(`delete from movie_overrides where movie_id = $1`, [movieId]);
  await pool.query(
    `update movies set is_deleted = true, updated_at = now() where id = $1`,
    [movieId],
  );
  invalidateCatalogCache();
}
