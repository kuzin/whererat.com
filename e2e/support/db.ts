import { Pool } from "pg";
import { hashPassword } from "../../src/lib/password-hash";
import { ADMIN, E2E_DATABASE_URL, LEGACY, MODERATOR } from "../config";
import { assertSafeE2EDatabase } from "./safety";

let pool: Pool | undefined;

export function db(): Pool {
  assertSafeE2EDatabase(E2E_DATABASE_URL);
  return (pool ??= new Pool({ connectionString: E2E_DATABASE_URL, max: 3 }));
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) {
  const result = await db().query<T>(sql, params);
  return result.rows;
}

/** Empties every table (keeps the schema), so each test starts from nothing. */
export async function resetDatabase() {
  const tables = await query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await db().query(`truncate ${list} restart identity cascade`);
}

const EMPTY_METADATA = {
  tagline: "",
  rating: "PG",
  director: "",
  originalLanguage: "English",
  productionCountries: [],
  metadataProvider: "e2e seed",
  lastSyncedAt: "2026-01-01",
  writers: "",
  cast: "",
  imdbRating: "",
  imdbVotes: "",
  metascore: "",
  awards: "",
};

export type SeedMovie = {
  slug: string;
  title: string;
  year: number;
  imdbId: string;
  summary?: string;
  deleted?: boolean;
};

export const MOVIES = {
  ratatouille: { slug: "ratatouille-2007", title: "Ratatouille", year: 2007, imdbId: "tt0382932", summary: "A rat who dreams of becoming a chef." },
  downton: { slug: "downton-abbey-2019", title: "Downton Abbey", year: 2019, imdbId: "tt6398184", summary: "The lives of the Crawley family and their servants. Life goes on at the great house." },
} satisfies Record<string, SeedMovie>;

export async function seedMovie(m: SeedMovie) {
  await query(
    `insert into movies (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, summary, metadata, is_deleted)
     values ($1,$2,$3,$4,100,'{Drama}','bg-stone-700','/favicon.svg','/favicon.svg',$5,$6,$7,$8,$9)`,
    [`seed-${m.slug}`, m.slug, m.title, m.year, `${m.title} poster`, m.imdbId, m.summary ?? `${m.title} summary.`, EMPTY_METADATA, m.deleted ?? false],
  );
}

/** A TV series (served under /shows/<slug>) so season/episode flows can be exercised. */
export const SERIES = { slug: "the-rat-show-2020", title: "The Rat Show", year: 2020, imdbId: "tt8000001" } satisfies SeedMovie;

export async function seedSeries() {
  await query(
    `insert into movies (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, summary, metadata, is_deleted)
     values ($1,$2,$3,$4,45,'{Comedy}','bg-stone-700','/favicon.svg','/favicon.svg',$5,$6,$7,$8,false)`,
    [`seed-${SERIES.slug}`, SERIES.slug, SERIES.title, SERIES.year, `${SERIES.title} poster`, SERIES.imdbId, "A sitcom about a rat.", { ...EMPTY_METADATA, syncSnapshot: { Type: "series", totalSeasons: "3", Year: "2020–" } }],
  );
}

export async function seedNews(items: Array<{ id: string; title: string; body: string; type?: string; published?: boolean }>) {
  for (const n of items) {
    await query(
      `insert into news_items (id, title, body, type, author_id, author_name, author_avatar_url, published_at)
       values ($1,$2,$3,$4,'acct-admin','E2E Admin','/favicon.svg',$5)`,
      [n.id, n.title, n.body, n.type ?? "announcement", n.published === false ? null : new Date()],
    );
  }
}

/** Approved submissions with images / spoilers / varied rodents, for realistic pages. */
export async function seedSightings(movie: { title: string; imdbId: string; year: number }, n: number, over: { spoiler?: boolean; kind?: "movie" | "series" } = {}) {
  for (let i = 1; i <= n; i++) {
    await query(
      `insert into submissions (id, movie_title, movie_year, imdb_id, imdb_kind, season_number, episode_number, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by, rodent_types)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved','E2E Tester',$13)`,
      [
        `seed-sight-${movie.imdbId}-${i}`, movie.title, movie.year, movie.imdbId, over.kind ?? "movie",
        over.kind === "series" ? 1 + (i % 3) : null, over.kind === "series" ? i : null,
        `${(i * 7) % 100}%`, `Sighting number ${i}`, `Rat ${i} scurries past the camera. **Bold** and _italic_.`,
        over.spoiler ?? false, 1 + (i % 4), i % 2 ? ["rat"] : ["mouse"],
      ],
    );
  }
}

export async function seedAccounts() {
  const rows: Array<[string, string, string, string, string]> = [
    ["acct-admin", ADMIN.username, ADMIN.name, "admin@e2e.test", "owner"],
    ["acct-mod", MODERATOR.username, MODERATOR.name, "mod@e2e.test", "moderator"],
    ["acct-legacy", LEGACY.username, LEGACY.name, "legacy@e2e.test", "moderator"],
  ];
  const hashes: Record<string, string> = {
    [ADMIN.username]: await hashPassword(ADMIN.password),
    [MODERATOR.username]: await hashPassword(MODERATOR.password),
    [LEGACY.username]: LEGACY.password, // deliberately plaintext (pre-hashing data)
  };
  for (const [id, username, name, email, role] of rows) {
    await query(
      `insert into accounts (id, username, display_name, email, avatar_url, role, password_hash)
       values ($1,$2,$3,$4,'/favicon.svg',$5,$6)`,
      [id, username, name, email, role, hashes[username]],
    );
  }
}

export type SeedSubmission = {
  id: string;
  movieTitle: string;
  imdbId: string;
  title: string;
  description?: string;
  movieYear?: number | null;
  status?: "pending" | "approved" | "rejected";
  timestamp?: string;
};

export async function seedSubmission(s: SeedSubmission) {
  await query(
    `insert into submissions (id, movie_title, movie_year, imdb_id, imdb_kind, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by)
     values ($1,$2,$3,$4,'movie',$5,$6,$7,false,1,$8,'E2E Tester')`,
    [s.id, s.movieTitle, s.movieYear ?? 2001, s.imdbId, s.timestamp ?? "42%", s.title, s.description ?? "A rat scurries across the frame.", s.status ?? "pending"],
  );
}

/** The standard starting point: both seed movies and all three accounts. */
export async function seedBaseline() {
  await resetDatabase();
  await seedMovie(MOVIES.ratatouille);
  await seedMovie(MOVIES.downton);
  await seedAccounts();
}
