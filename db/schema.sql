-- WhereRat Postgres baseline schema
-- Keeps current app concepts but normalizes into relational tables.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists accounts (
  id text primary key,
  username text not null unique,
  display_name text not null,
  email text not null unique,
  avatar_url text not null,
  role text not null check (role in ('owner', 'moderator')),
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists movies (
  id text primary key,
  slug text not null unique,
  title text not null,
  release_year int not null check (release_year > 1800 and release_year < 3000),
  runtime_minutes int not null check (runtime_minutes > 0),
  genres text[] not null default '{}',
  poster_tone text not null,
  poster_url text not null,
  backdrop_url text not null,
  poster_alt text not null,
  imdb_id text not null unique,
  tmdb_id text,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists movies_title_idx on movies using gin (to_tsvector('simple', title));
create index if not exists movies_genres_idx on movies using gin (genres);
-- Full-text search on title + summary (English stemming for better recall)
create index if not exists movies_fts_idx on movies using gin (to_tsvector('english', title || ' ' || summary));
-- Trigram index on title for fuzzy/typo-tolerant matching
create index if not exists movies_title_trgm_idx on movies using gin (title gin_trgm_ops);

create table if not exists sightings (
  id text primary key,
  movie_id text not null references movies(id) on delete cascade,
  timestamp_code text not null,
  title text,
  description text not null,
  prominence text not null check (prominence in ('blink-and-miss', 'background', 'scene-stealer')),
  scene_type text not null check (scene_type in ('live-action', 'animated', 'symbolic', 'swarm', 'final-shot')),
  spoiler boolean not null default false,
  confidence text not null check (confidence in ('needs-source', 'likely', 'verified')),
  verification_state text not null check (verification_state in ('verified', 'pending', 'rejected')),
  verified_by text not null,
  source_ids text[] not null default '{}',
  curator_note text,
  approximate_rat_count int check (approximate_rat_count between 1 and 9999),
  submitter_name text,
  submission_reviewed_at timestamptz,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sightings_movie_id_idx on sightings(movie_id);
create index if not exists sightings_timestamp_code_idx on sightings(timestamp_code);
-- Full-text search on sighting title + description for catalog content search
create index if not exists sightings_fts_idx on sightings using gin (
  to_tsvector('english', coalesce(title, '') || ' ' || description)
);

create table if not exists movie_overrides (
  movie_id text primary key references movies(id) on delete cascade,
  override jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists sighting_overrides (
  sighting_id text primary key references sightings(id) on delete cascade,
  override jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists sighting_images (
  id uuid primary key default gen_random_uuid(),
  sighting_id text not null references sightings(id) on delete cascade,
  image_url text not null,
  image_alt text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists sighting_images_unique_per_order
  on sighting_images(sighting_id, sort_order);

create table if not exists submissions (
  id text primary key,
  movie_title text not null,
  movie_year int,
  imdb_id text,
  imdb_kind text check (imdb_kind in ('movie', 'series')),
  season_number int check (season_number is null or season_number >= 1),
  episode_number int check (episode_number is null or episode_number >= 1),
  episode_title text,
  timestamp_code text not null,
  title text,
  description text not null,
  spoiler boolean not null default false,
  approximate_rat_count int not null check (approximate_rat_count between 1 and 9999),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  submitted_by text not null,
  submitter_email text,
  curator_note text,
  duplicate_hint text,
  movie_poster_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table submissions add column if not exists imdb_kind text;
alter table submissions add column if not exists season_number int;
alter table submissions add column if not exists episode_number int;
alter table submissions add column if not exists episode_title text;

alter table submissions
  drop constraint if exists submissions_imdb_kind_check;
alter table submissions
  add constraint submissions_imdb_kind_check
  check (imdb_kind is null or imdb_kind in ('movie', 'series'));

alter table submissions
  drop constraint if exists submissions_season_number_check;
alter table submissions
  add constraint submissions_season_number_check
  check (season_number is null or season_number >= 1);

alter table submissions
  drop constraint if exists submissions_episode_number_check;
alter table submissions
  add constraint submissions_episode_number_check
  check (episode_number is null or episode_number >= 1);

create table if not exists submission_images (
  id uuid primary key default gen_random_uuid(),
  submission_id text not null references submissions(id) on delete cascade,
  image_url text not null,
  image_alt text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists submission_images_unique_per_order
  on submission_images(submission_id, sort_order);

create table if not exists review_actions (
  id text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  movie_title text not null,
  action text not null check (action in ('approved', 'edited', 'edited and approved', 'merged duplicate', 'rejected')),
  moderator_id text not null,
  moderator_name text not null,
  reviewed_at timestamptz not null,
  note text not null
);

create index if not exists review_actions_submission_reviewed_idx
  on review_actions(submission_id, reviewed_at desc);

-- Content warnings on sightings and submissions
alter table sightings add column if not exists content_warnings text[] not null default '{}';
alter table submissions add column if not exists content_warnings text[] not null default '{}';

-- Rodent types on sightings and submissions (defaults to rat)
alter table sightings add column if not exists rodent_types text[] not null default '{rat}';
alter table submissions add column if not exists rodent_types text[] not null default '{rat}';

-- Free-text species label submitted when the user picks "Other" as the rodent
-- type. Stored on both submissions and sightings and shown publicly as a chip.
alter table submissions add column if not exists other_rodent_label text;
alter table sightings add column if not exists other_rodent_label text;

-- News items (owner-curated posts shown on /news)
create table if not exists news_items (
  id text primary key,
  title text not null,
  body text not null,
  type text not null check (type in ('announcement', 'product-news', 'community', 'update')),
  image_url text,
  image_alt text,
  image_position_x float not null default 50,
  image_position_y float not null default 50,
  image_zoom float not null default 1,
  author_id text not null,
  author_name text not null,
  author_avatar_url text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table news_items add column if not exists image_position_x float not null default 50;
alter table news_items add column if not exists image_position_y float not null default 50;
alter table news_items add column if not exists image_zoom float not null default 1;

-- Per-image positioning (drag-to-reposition / scroll-to-zoom) on submission + sighting
-- galleries. Legacy rows default to centered, 1× zoom — visually identical to the old
-- object-cover behavior.
alter table sighting_images add column if not exists image_position_x float not null default 50;
alter table sighting_images add column if not exists image_position_y float not null default 50;
alter table sighting_images add column if not exists image_zoom float not null default 1;
alter table submission_images add column if not exists image_position_x float not null default 50;
alter table submission_images add column if not exists image_position_y float not null default 50;
alter table submission_images add column if not exists image_zoom float not null default 1;

-- Newsletter digest sends: one row per "Send digest" action from the
-- moderation Compose newsletter modal, plus a join table of which news
-- items were included. Lets us hide already-newslettered posts in the
-- composer and surface a history of past sends.
create table if not exists newsletter_sends (
  id text primary key,
  sent_at timestamptz not null default now(),
  sent_by_id text not null,
  sent_by_name text not null,
  recipient_count int not null default 0,
  subject text not null
);
create table if not exists newsletter_send_items (
  newsletter_send_id text not null references newsletter_sends(id) on delete cascade,
  news_item_id text not null references news_items(id) on delete cascade,
  sort_order int not null default 0,
  primary key (newsletter_send_id, news_item_id)
);
create index if not exists newsletter_send_items_news_idx on newsletter_send_items(news_item_id);

-- Email preferences (marketing opt-in, keyed by email)
create table if not exists email_preferences (
  email text primary key,
  marketing_opt_in boolean not null default false,
  unsubscribe_token text not null unique default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Shared rate-limit counters (one row per key; fixed window). Used by public
-- submissions so limits hold across serverless instances. The app falls back to
-- per-instance in-memory limits until this table exists.
create table if not exists rate_limits (
  key text primary key,
  count int not null,
  reset_at timestamptz not null
);
create index if not exists rate_limits_reset_idx on rate_limits(reset_at);
