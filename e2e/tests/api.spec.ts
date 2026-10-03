import { test, expect } from "../fixtures";
import { MOVIES, query } from "../support/db";

function multipart(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

const valid = (over: Record<string, string> = {}) => ({
  movieTitle: "API Movie",
  imdbId: "tt7300001",
  movieYear: "2002",
  imdbKind: "movie",
  sightingTitle: "API rat",
  timestamp: "42%",
  description: "Seen via the API.",
  submitterName: "API Tester",
  ...over,
});

test.describe("health and version", () => {
  test("health/db reports ok", async ({ request }) => {
    const res = await request.get("/api/health/db");
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("version lists web and api versions", async ({ request }) => {
    const body = await (await request.get("/api/version")).json();
    expect(body).toHaveProperty("web");
    expect(body).toHaveProperty("api");
  });
});

test.describe("GET /api/v1 (consumed by the mobile app)", () => {
  test("catalog returns the seeded movies", async ({ request }) => {
    const res = await request.get("/api/v1/catalog");
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain(MOVIES.ratatouille.slug);
    expect(text).toContain(MOVIES.downton.slug);
  });

  test("movie detail returns the movie and only published sightings", async ({ request }) => {
    await query(
      `insert into submissions (id, movie_title, movie_year, imdb_id, imdb_kind, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by)
       values ('s-pub','Ratatouille',2007,$1,'movie','10%','Published one','d',false,1,'approved','t'),
              ('s-pend','Ratatouille',2007,$1,'movie','20%','Pending one','d',false,1,'pending','t')`,
      [MOVIES.ratatouille.imdbId],
    );
    const res = await request.get(`/api/v1/movies/${MOVIES.ratatouille.slug}`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain("Published one");
    expect(text).not.toContain("Pending one");
  });

  test("an unknown movie is a 404", async ({ request }) => {
    expect((await request.get("/api/v1/movies/no-such-movie")).status()).toBe(404);
  });
});

test.describe("POST /api/v1/submissions", () => {
  test("a valid multipart submission is accepted and queued", async ({ request }) => {
    const res = await request.post("/api/v1/submissions", { multipart: valid() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const [row] = await query<{ status: string; title: string }>(`select status, title from submissions where id = $1`, [body.submissionId]);
    expect(row).toEqual({ status: "pending", title: "API rat" });
  });

  test("non-multipart bodies get 415", async ({ request }) => {
    const res = await request.post("/api/v1/submissions", { data: { movieTitle: "x" } });
    expect(res.status()).toBe(415);
  });

  test("missing required fields get 422, not a server error", async ({ request }) => {
    const res = await request.post("/api/v1/submissions", { multipart: valid({ description: "" }) });
    expect(res.status()).toBe(422);
    expect((await res.json()).ok).toBe(false);
  });

  test("a missing IMDb id gets 422", async ({ request }) => {
    const res = await request.post("/api/v1/submissions", { multipart: valid({ imdbId: "" }) });
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toBe("no-imdb");
  });

  for (const [name, over] of [
    ["an out-of-range year", { movieYear: "99999999999" }],
    ["a NUL byte in a field", { sightingTitle: "a\u0000b" }],
    ["an enormous season number", { imdbKind: "series", seasonNumber: "99999999999", episodeNumber: "1" }],
    ["a junk timestamp", { timestamp: "<script>" }],
  ] as const) {
    test(`${name} never produces a 500 or leaks database errors`, async ({ request }) => {
      const res = await request.post("/api/v1/submissions", { multipart: valid(over) });
      expect(res.status()).toBeLessThan(500);
      const text = await res.text();
      expect(text).not.toMatch(/out of range|invalid byte sequence|violates|syntax for type|relation "/i);
    });
  }

  test("hostile poster and image URLs are not stored", async ({ request }) => {
    const res = await request.post("/api/v1/submissions", {
      multipart: valid({
        moviePosterUrl: "javascript:alert(1)",
        sightingImageListManaged: "1",
        sightingImageUrl: "https://evil.example/tracker.png",
      }),
    });
    expect(res.status()).toBe(200);
    const [row] = await query<{ movie_poster_url: string | null }>(`select movie_poster_url from submissions`);
    expect(row!.movie_poster_url).toBeNull();
    expect(await query(`select 1 from submission_images`)).toHaveLength(0);
  });

  test("a sixth submission from one address in an hour is 429", async ({ request }) => {
    for (let i = 1; i <= 5; i++) {
      const ok = await request.post("/api/v1/submissions", { multipart: valid({ imdbId: `tt730010${i}` }) });
      expect(ok.status()).toBe(200);
    }
    const blocked = await request.post("/api/v1/submissions", { multipart: valid({ imdbId: "tt7300109" }) });
    expect(blocked.status()).toBe(429);
  });

  test("GET on the submissions route is not allowed", async ({ request }) => {
    expect((await request.get("/api/v1/submissions")).status()).toBe(405);
  });

  test("an anonymous request can't auto-approve", async ({ request }) => {
    const res = await request.post("/api/v1/submissions", { multipart: valid({ autoApprove: "on" }) });
    expect(res.status()).toBe(200);
    const [row] = await query<{ status: string }>(`select status from submissions`);
    expect(row!.status).toBe("pending");
  });
});

test.describe("scheduled job endpoint", () => {
  test("requires the cron secret", async ({ request }) => {
    for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }, { authorization: "Bearer " }, { authorization: "e2e-cron-secret" }]) {
      const res = await request.get("/api/cron/imdb-resync", { headers });
      expect([401, 403]).toContain(res.status());
    }
  });
});

test.describe("uploads endpoint", () => {
  test("rejects anonymous uploads", async ({ request }) => {
    const res = await request.post("/api/uploads/sighting-images", {
      multipart: { file: { name: "a.png", mimeType: "image/png", buffer: Buffer.from("x") } },
    });
    expect(res.status()).toBe(401);
  });
});

void multipart;
