import { test, expect } from "../fixtures";
import { MOVIES, query, seedSubmission } from "../support/db";

test.describe("browsing the catalog", () => {
  test("the home page lists every movie", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(MOVIES.ratatouille.title).first()).toBeVisible();
    await expect(page.getByText(MOVIES.downton.title).first()).toBeVisible();
  });

  test("searching narrows the list and an empty search says so", async ({ page }) => {
    await page.goto("/?q=Ratatouille");
    await expect(page.getByText(MOVIES.ratatouille.title).first()).toBeVisible();
    await expect(page.getByText(MOVIES.downton.title)).toHaveCount(0);

    await page.goto("/?q=zzzz-no-such-movie");
    await expect(page.getByText(MOVIES.ratatouille.title)).toHaveCount(0);
    await expect(page.getByText(MOVIES.downton.title)).toHaveCount(0);
  });

  test("a search can't be turned into a wildcard that matches everything", async ({ page }) => {
    // Known bug: `m.imdb_id ilike $1` doesn't escape LIKE wildcards, so "%" matches every movie
    // (pinned by an it.fails unit test in src/__tests__/lib/movie-catalog.test.ts). Remove
    // test.fail() when it is fixed.
    test.fail(true, "LIKE wildcard in catalog search");
    await page.goto("/?q=%25");
    await expect(page.getByText(MOVIES.ratatouille.title)).toHaveCount(0);
    await expect(page.getByText(MOVIES.downton.title)).toHaveCount(0);
  });

  test("the rodent filter uses published sightings (it used to match nothing)", async ({ page }) => {
    await seedSubmission({ id: "sub-mouse", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "A mouse", status: "approved" });
    await query(`update submissions set rodent_types = '{mouse}' where id = 'sub-mouse'`);

    await page.goto("/?rodent=mouse");
    await expect(page.getByText(MOVIES.ratatouille.title).first()).toBeVisible();
    await expect(page.getByText(MOVIES.downton.title)).toHaveCount(0);

    await page.goto("/?rodent=squirrel");
    await expect(page.getByText(MOVIES.ratatouille.title)).toHaveCount(0);
    await expect(page.getByText(/in this hole/)).toBeVisible();
  });

  test("a pending (unreviewed) sighting is never public", async ({ page }) => {
    await seedSubmission({ id: "sub-secret", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Not yet reviewed" });
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Not yet reviewed")).toHaveCount(0);
  });
});

test.describe("movie pages", () => {
  test("show the title and approved sightings", async ({ page }) => {
    await seedSubmission({ id: "sub-pub", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Remy in the kitchen", description: "Remy darts past the stove.", status: "approved" });
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page).toHaveTitle(/Ratatouille/);
    await expect(page.getByText("Remy in the kitchen").first()).toBeVisible();
  });

  test("an unknown movie is a 404", async ({ page }) => {
    const response = await page.goto("/movies/this-movie-does-not-exist");
    expect(response?.status()).toBe(404);
  });

  test("a soft-deleted movie is gone from the catalog and returns 404", async ({ page }) => {
    await query(`update movies set is_deleted = true where slug = $1`, [MOVIES.downton.slug]);
    const response = await page.goto(`/movies/${MOVIES.downton.slug}`);
    expect(response?.status()).toBe(404);
    await page.goto("/");
    await expect(page.getByText(MOVIES.downton.title)).toHaveCount(0);
  });

  test("only moderators see the edit controls", async ({ page, login }) => {
    await seedSubmission({ id: "sub-edit", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Editable sighting", status: "approved" });
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByRole("link", { name: "Edit sighting" })).toHaveCount(0);

    await login();
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByRole("link", { name: "Edit sighting" }).first()).toBeVisible();
  });

  test("the edit form on a movie page is not reachable without a session", async ({ page }) => {
    await seedSubmission({ id: "sub-edit2", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Locked sighting", status: "approved" });
    await page.goto(`/movies/${MOVIES.ratatouille.slug}?editSighting=queue-sub-edit2`);
    await expect(page.getByRole("button", { name: "Save sighting" })).toHaveCount(0);
  });
});

test.describe("site pages", () => {
  for (const path of ["/about", "/guidelines", "/privacy", "/submit", "/login"]) {
    test(`${path} renders`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading").first()).toBeVisible();
    });
  }

  test("/news renders (an empty news feed is fine)", async ({ page }) => {
    const response = await page.goto("/news");
    expect(response?.status()).toBe(200);
    await expect(page.locator("main")).toBeVisible();
  });

  test("the sitemap lists movies, including ones added after the build", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(MOVIES.ratatouille.slug);
    expect(xml).toContain(MOVIES.downton.slug);
  });

  test("unknown routes show the not-found page", async ({ page }) => {
    const response = await page.goto("/definitely/not/a/page");
    expect(response?.status()).toBe(404);
  });
});
