/** Hostile query strings and paths: nothing may 500, leak internals, or execute reflected markup. */
import { test, expect } from "../fixtures";
import { MOVIES, SERIES, seedSeries, seedSightings } from "../support/db";

const XSS = encodeURIComponent('"><script>window.__pwned=1</script><img src=x onerror=window.__pwned=2>');
const LEAK = /ECONNREFUSED|stack trace|at Object\.|at async|pg_|relation "|syntax error at|violates|node_modules|Application error/i;

/** Known bugs: each of these currently returns a 5xx. Remove the entry when it is fixed. */
const KNOWN_5XX: Record<string, string> = {
  "/movies/%ff%fe": "invalid UTF-8 in a movie slug returns 500 (should be 404)",
  "/moderation/users?create=1&error=__proto__": "an `error` param named __proto__ crashes the users page (prototype-key lookup)",
  "/api/v1/movies/%00": "a NUL byte in the slug reaches Postgres and returns 500 (should be 404)",
  "/api/unsubscribe?token=%00": "a NUL byte in the token reaches Postgres and returns 500 (should redirect to ?status=invalid)",
};

const PUBLIC = [
  "/?page=-1", "/?page=0", "/?page=abc", "/?page=999999", "/?page=1.5", "/?page=1e3", "/?page=%00",
  `/?q=${XSS}`, "/?q=%00", `/?q=${"a".repeat(5000)}`, "/?genre=%27%3B--", "/?genre[]=a", "/?rodent=__proto__", "/?rodent=constructor",
  "/?q=a&q=b", "/?sort=zzz", `/?genre=${XSS}&rodent=${XSS}`,
  `/movies/${MOVIES.ratatouille.slug}?page=-5`, `/movies/${MOVIES.ratatouille.slug}?page=999`, `/movies/${MOVIES.ratatouille.slug}?page=abc`,
  `/movies/${MOVIES.ratatouille.slug}?sort=zzz`, `/movies/${MOVIES.ratatouille.slug}?sort[]=a`, `/movies/${MOVIES.ratatouille.slug}?rodent=${XSS}`,
  `/movies/${MOVIES.ratatouille.slug}?editSighting=queue-nonexistent`, `/movies/${MOVIES.ratatouille.slug}?editSighting=${XSS}`, `/movies/${MOVIES.ratatouille.slug}?editMovie=1`,
  `/movies/${MOVIES.ratatouille.slug}?toast=__proto__`, `/movies/${MOVIES.ratatouille.slug}?toast=${XSS}`,
  `/shows/${SERIES.slug}?page=-1&sort=zzz`, `/shows/${MOVIES.ratatouille.slug}`, `/movies/${SERIES.slug}`,
  "/movies/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/movies/%00", "/movies/%ff%fe", `/movies/${"x".repeat(5000)}`, "/movies/", "/movies/<script>",
  `/submit?for=${XSS}&title=${XSS}&year=abc&poster=javascript:alert(1)&status=${XSS}&match=${XSS}`, "/submit?for=tt0000000&title=&year=-1", "/submit?status=__proto__",
  `/login?next=${XSS}&error=${XSS}`, `/login?toast=${XSS}`, `/unsubscribed?status=${XSS}`, `/confirm-subscription?status=${XSS}&token=${XSS}`, `/news?post=${XSS}`, "/news?post=%00",
  "/_next/image?url=%2Fetc%2Fpasswd&w=64&q=75", "/_next/image?url=https%3A%2F%2Fevil.example%2Fx.png&w=64&q=75", "/_next/image?url=%2Ffavicon.svg&w=999999&q=75",
  "/api/health/db?x=" + XSS, "/robots.txt", "/manifest.webmanifest", "/favicon.ico",
];

test.describe("public URLs", () => {
  for (const path of PUBLIC) {
    test(`${path.slice(0, 90)}`, async ({ page }) => {
      if (KNOWN_5XX[path]) test.fail(true, KNOWN_5XX[path]!);
      await seedSeries();
      await seedSightings(MOVIES.ratatouille, 3);
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      const status = response?.status() ?? 0;
      expect(status, `status for ${path}`).toBeLessThan(500);
      const body = await page.content();
      expect(body).not.toMatch(LEAK);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      // the hostile markup must never become real elements
      expect(await page.locator("script", { hasText: "__pwned" }).count()).toBe(0);
      expect(await page.locator("img[onerror]").count()).toBe(0);
    });
  }
});

test.describe("moderator URLs", () => {
  const MOD = [
    "/moderation?edit=nonexistent", "/moderation?edit=%00", `/moderation?edit=${XSS}`, "/moderation?page=-1", "/moderation?page=abc&tab=zzz",
    `/moderation?toast=${XSS}`, "/moderation?toast=__proto__", "/moderation?addUser=zzz&editUser=zzz",
    "/moderation/users?edit=nonexistent", `/moderation/users?edit=${XSS}`, "/moderation/users?create=1&error=__proto__", `/moderation/users?error=${XSS}`,
    "/moderation/news?edit=zzz", "/moderation/news?compose=1", `/moderation/news?edit=${XSS}`, "/moderation/news?create=1&toast=__proto__",
    "/profile?status=__proto__", `/profile?status=${XSS}`,
  ];
  for (const path of MOD) {
    test(`${path.slice(0, 90)}`, async ({ page, login }) => {
      if (KNOWN_5XX[path]) test.fail(true, KNOWN_5XX[path]!);
      await login();
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status() ?? 0, `status for ${path}`).toBeLessThan(500);
      expect(await page.content()).not.toMatch(LEAK);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    });
  }
});

test.describe("API query strings", () => {
  const API = [
    "/api/v1/catalog?page=-1", "/api/v1/catalog?page=abc&pageSize=99999", "/api/v1/catalog?pageSize=0", "/api/v1/catalog?sort=zzz", "/api/v1/catalog?q=%00",
    `/api/v1/catalog?q=${XSS}&genre=${XSS}`, `/api/v1/catalog?q=${"a".repeat(5000)}`, "/api/v1/catalog?q=%25", "/api/v1/catalog?genre[]=a",
    `/api/v1/movies/${MOVIES.ratatouille.slug}?x=1`, "/api/v1/movies/%00", `/api/v1/movies/${"x".repeat(5000)}`, "/api/v1/movies/..%2f..%2fetc",
    "/api/movies/search?q=", "/api/movies/search?q=a", "/api/movies/search?q=%00", `/api/movies/search?q=${"a".repeat(5000)}`, `/api/movies/search?q=${XSS}`, "/api/movies/search?q=rat&page=-1",
    "/api/movies/episodes", "/api/movies/episodes?imdbId=zzz", "/api/movies/episodes?imdbId=%00&season=-1", "/api/movies/episodes?imdbId=tt0000001&season=99999999999",
    "/api/unsubscribe?token=%00", `/api/unsubscribe?token=${XSS}`, "/api/cron/imdb-resync?x=1",
  ];
  for (const path of API) {
    test(`${path.slice(0, 90)}`, async ({ request }) => {
      if (KNOWN_5XX[path]) test.fail(true, KNOWN_5XX[path]!);
      const res = await request.get(path);
      expect(res.status(), `status for ${path}`).toBeLessThan(500);
      expect(await res.text()).not.toMatch(LEAK);
    });
  }
});
