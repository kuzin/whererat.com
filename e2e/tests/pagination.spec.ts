import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { MOVIES, query, seedSightings } from "../support/db";

async function seedManyMovies(n: number) {
  await query(
    `insert into movies (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, summary, metadata, is_deleted, created_at)
     select 'bulk-'||g, 'bulk-movie-'||g||'-2001', 'Bulk Movie '||lpad(g::text,3,'0'), 2001, 90, '{Drama}', 'bg-stone-700', '/favicon.svg', '/favicon.svg', 'poster', 'tt'||lpad((9000000+g)::text,7,'0'), 'Bulk movie summary '||g,
            '{"tagline":"","rating":"PG","director":"","originalLanguage":"English","productionCountries":[],"metadataProvider":"e2e","lastSyncedAt":"2026-01-01","writers":"","cast":"","imdbRating":"","imdbVotes":"","metascore":"","awards":""}'::jsonb, false,
            now() - (g || ' minutes')::interval
     from generate_series(1, $1) g`,
    [n],
  );
}

const movieLinks = (page: Page) =>
  page.$$eval('a[href^="/movies/"]', (as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!.split("?")[0]!))]);

test.describe("home page pagination (50 per page)", () => {
  test("122 movies (120 + the 2 seeded) split 50 / 50 / 22 with no duplicates or gaps", async ({ page }) => {
    await seedManyMovies(120);
    const all: string[] = [];
    const sizes: number[] = [];
    for (const p of [1, 2, 3]) {
      await page.goto(`/?page=${p}`);
      const links = await movieLinks(page);
      sizes.push(links.length);
      all.push(...links);
    }
    expect(sizes).toEqual([50, 50, 22]);
    expect(new Set(all).size, "every movie appears on exactly one page").toBe(122);
  });

  for (const bad of ["0", "-1", "abc", "1.5", ""]) {
    test(`?page=${bad || "(empty)"} falls back to the first page`, async ({ page }) => {
      await seedManyMovies(60);
      await page.goto(`/?page=${bad}`);
      expect((await movieLinks(page)).length).toBe(50);
    });
  }

  test("a page beyond the end doesn't crash or show someone else's movies", async ({ page }) => {
    await seedManyMovies(60);
    const res = await page.goto("/?page=99");
    expect(res?.status()).toBeLessThan(500);
    const links = await movieLinks(page);
    expect(links.length).toBeLessThanOrEqual(50);
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  });

  test("searching an exact title surfaces it on the first page even in a big catalog", async ({ page }) => {
    test.fail(true, "same root cause: search results aren't ranked by relevance (exact title ends up on page 3)");
    await seedManyMovies(120);
    await page.goto("/?q=Bulk+Movie+110");
    expect(await movieLinks(page)).toContain("/movies/bulk-movie-110-2001");
  });

  test("searching a franchise's exact title ranks that title first, not the newest sequel", async ({ page }) => {
    // Known bug: results are sorted by the page's sort order (newest first) after matching, and
    // trigram similarity makes every sequel match, so "Stuart Little" lists the sequels first.
    test.fail(true, "search results aren't ranked by relevance");
    for (const [i, title] of ["Stuart Little", "Stuart Little 2", "Stuart Little 3", "Little Women", "Stuart"].entries()) {
      await query(
        `insert into movies (id, slug, title, release_year, runtime_minutes, genres, poster_tone, poster_url, backdrop_url, poster_alt, imdb_id, summary, metadata, is_deleted, created_at)
         values ($1,$2,$3,1999,90,'{Family}','bg-stone-700','/favicon.svg','/favicon.svg','p',$4,'A mouse family.','{}'::jsonb,false, now() - ($5 || ' days')::interval)`,
        [`f-${i}`, `franchise-${i}`, title, `tt950000${i}`, String(10 - i)],
      );
    }
    await page.goto("/?q=Stuart+Little");
    const first = (await movieLinks(page)).find((h) => h.startsWith("/movies/franchise-"));
    expect(first).toBe("/movies/franchise-0");
  });

  test("Next / Previous move between pages and update the URL", async ({ page }) => {
    await seedManyMovies(120);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2/);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=3/);
    await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(page).toHaveURL(/page=2/);
  });

  test("the pages are reachable as real links (crawlable, and usable without JavaScript)", async ({ page }) => {
    // Known issue: the controls are <button>s calling router.push, so there is no <a href> to
    // page 2+. Search engines can't follow them and they don't work with JavaScript off.
    test.fail(true, "catalog pagination has no real links");
    await seedManyMovies(120);
    await page.goto("/");
    await expect(page.locator('a[href*="page=2"]').first()).toBeVisible();
  });
});

test.describe("sightings on a movie page (10 per page)", () => {
  test("25 sightings split 10 / 10 / 5, none repeated", async ({ page }) => {
    await seedSightings(MOVIES.ratatouille, 25);
    const seen: string[] = [];
    const sizes: number[] = [];
    for (const p of [1, 2, 3]) {
      await page.goto(`/movies/${MOVIES.ratatouille.slug}?page=${p}`);
      const titles = await page.locator("text=/Sighting number \\d+/ >> visible=true").allInnerTexts();
      const unique = [...new Set(titles.map((t) => t.match(/Sighting number \d+/)![0]))];
      sizes.push(unique.length);
      seen.push(...unique);
    }
    expect(sizes).toEqual([10, 10, 5]);
    expect(new Set(seen).size).toBe(25);
  });

  test("a page past the end clamps instead of showing an empty list", async ({ page }) => {
    await seedSightings(MOVIES.ratatouille, 12);
    const res = await page.goto(`/movies/${MOVIES.ratatouille.slug}?page=99`);
    expect(res?.status()).toBeLessThan(500);
    const titles = await page.locator("text=/Sighting number \\d+/ >> visible=true").count();
    expect(titles, "an out-of-range page should show the last page, not nothing").toBeGreaterThan(0);
  });
});
