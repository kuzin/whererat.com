import { test, expect } from "../fixtures";
import { MOVIES, query, seedSubmission } from "../support/db";

const card = (page: import("@playwright/test").Page, text: string) =>
  page.locator("article", { hasText: text });

test.describe("approving", () => {
  test("a title not in the catalog gets its own entry — not a fuzzy match onto Downton Abbey", async ({ page, login }) => {
    // Downton's summary contains the word "life": the old fuzzy title search matched it.
    await seedSubmission({ id: "sub-life", movieTitle: "Life", imdbId: "tt5442430", movieYear: 2017, title: "A rat in the lab" });
    await login();

    const pending = card(page, "A rat in the lab");
    await expect(pending).toContainText("not yet in the catalog");
    await expect(pending).not.toContainText("Already in catalog");
    await pending.getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    const movies = await query<{ slug: string; title: string }>(`select slug, title from movies where imdb_id = 'tt5442430'`);
    expect(movies).toEqual([{ slug: "life-2017", title: "Life" }]);

    await page.goto("/movies/life-2017");
    await expect(page.getByText("A rat in the lab").first()).toBeVisible();
    await page.goto(`/movies/${MOVIES.downton.slug}`);
    await expect(page.getByText("A rat in the lab")).toHaveCount(0);
  });

  test("a submission for an existing title is flagged as already in the catalog and lands on it", async ({ page, login }) => {
    await seedSubmission({ id: "sub-rat", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, movieYear: 2007, title: "Remy on the counter" });
    await login();
    const pending = card(page, "Remy on the counter");
    await expect(pending).toContainText("Already in catalog");
    await pending.getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Remy on the counter").first()).toBeVisible();
    expect(await query(`select 1 from movies where imdb_id = $1`, [MOVIES.ratatouille.imdbId])).toHaveLength(1);
  });

  test("an out-of-range year no longer blocks approval (it used to crash on a DB check)", async ({ page, login }) => {
    await seedSubmission({ id: "sub-year", movieTitle: "Year Test", imdbId: "tt7000001", movieYear: null, title: "Year rat" });
    await login();
    await card(page, "Year rat").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);
    const [row] = await query<{ release_year: number }>(`select release_year from movies where imdb_id = 'tt7000001'`);
    expect(row!.release_year).toBeGreaterThan(1800);
  });

  test("a soft-deleted movie is restored when a submission for it is approved", async ({ page, login }) => {
    await query(`update movies set is_deleted = true where slug = $1`, [MOVIES.ratatouille.slug]);
    await seedSubmission({ id: "sub-back", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Back again" });
    await login();
    await card(page, "Back again").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);
    const [row] = await query<{ is_deleted: boolean }>(`select is_deleted from movies where slug = $1`, [MOVIES.ratatouille.slug]);
    expect(row!.is_deleted).toBe(false);
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Back again").first()).toBeVisible();
  });
});

test.describe("denying and the audit trail", () => {
  test("denying removes it from the queue and never publishes it", async ({ page, login }) => {
    await seedSubmission({ id: "sub-no", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Unwanted sighting" });
    await login();
    await card(page, "Unwanted sighting").getByRole("button", { name: "Deny" }).click();
    await expect(page).toHaveURL(/toast=moderation-rejected/);
    // It moves to the (hidden) Denied tab: no longer visible in the pending list.
    await expect(card(page, "Unwanted sighting").first()).toBeHidden();

    const [sub] = await query<{ status: string }>(`select status from submissions where id = 'sub-no'`);
    expect(sub!.status).toBe("rejected");
    const audit = await query<{ action: string; moderator_name: string }>(`select action, moderator_name from review_actions where submission_id = 'sub-no'`);
    expect(audit).toEqual([{ action: "rejected", moderator_name: "E2E Admin" }]);

    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Unwanted sighting")).toHaveCount(0);
  });

  test("approving writes an audit row naming the moderator", async ({ page, login }) => {
    await seedSubmission({ id: "sub-audit", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Audited sighting" });
    await login();
    await card(page, "Audited sighting").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);
    const audit = await query<{ action: string; moderator_name: string }>(`select action, moderator_name from review_actions where submission_id = 'sub-audit'`);
    expect(audit).toEqual([{ action: "approved", moderator_name: "E2E Admin" }]);
  });
});

test.describe("editing a title", () => {
  test("a pending sighting filed under the wrong title can be moved by IMDb id before approval", async ({ page, login }) => {
    // The "Life" mix-up: submitted as Life, but it really belongs to Ratatouille.
    await seedSubmission({ id: "sub-move", movieTitle: "Life", imdbId: "tt5442430", title: "Misfiled rat" });
    await login();
    await page.goto("/moderation?edit=sub-move");

    await page.getByLabel("Movie or show title").fill("Ratatouille");
    await page.getByLabel("IMDb ID").fill(MOVIES.ratatouille.imdbId);
    await page.getByRole("button", { name: "Save & Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Misfiled rat").first()).toBeVisible();
    expect(await query(`select 1 from movies where imdb_id = 'tt5442430'`)).toHaveLength(0);
  });

  test("an approved sighting can be moved to another title from its edit form, landing on the new page", async ({ page, login }) => {
    await seedSubmission({ id: "sub-live", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Wrong movie rat", status: "approved" });
    await login();
    await page.goto(`/movies/${MOVIES.ratatouille.slug}?editSighting=queue-sub-live`);

    await page.getByLabel("Movie or show title").fill("Downton Abbey");
    await page.getByLabel("IMDb ID").fill(MOVIES.downton.imdbId);
    await page.getByRole("button", { name: "Save sighting" }).click();

    await expect(page).toHaveURL(new RegExp(`/movies/${MOVIES.downton.slug}.*toast=sighting-saved`));
    await expect(page.getByText("Wrong movie rat").first()).toBeVisible();
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Wrong movie rat")).toHaveCount(0);
  });

  test("an invalid IMDb id is rejected with an error and nothing is saved", async ({ page, login }) => {
    await seedSubmission({ id: "sub-bad", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Keep me" });
    await login();
    await page.goto("/moderation?edit=sub-bad");
    // Bypass the browser's own pattern validation to exercise the server-side check.
    await page.evaluate(() => {
      const form = document.getElementById("moderation-edit-form") as HTMLFormElement;
      form.noValidate = true;
      (form.elements.namedItem("imdbId") as HTMLInputElement).value = "not-an-id";
    });
    await page.getByRole("button", { name: "Save edits" }).click();
    await expect(page).toHaveURL(/toast=invalid-movie/);
    const [row] = await query<{ imdb_id: string }>(`select imdb_id from submissions where id = 'sub-bad'`);
    expect(row!.imdb_id).toBe(MOVIES.ratatouille.imdbId);
  });

  test("a NUL byte in an edited title is stripped instead of crashing the page", async ({ page, login }) => {
    await seedSubmission({ id: "sub-nul", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Nul rat" });
    await login();
    await page.goto("/moderation?edit=sub-nul");
    await page.evaluate(() => {
      const form = document.getElementById("moderation-edit-form") as HTMLFormElement;
      (form.elements.namedItem("movieTitle") as HTMLInputElement).value = "Rata\u0000touille";
    });
    await page.getByRole("button", { name: "Save edits" }).click();
    await expect(page).toHaveURL(/toast=moderation-saved/);
    const [row] = await query<{ movie_title: string }>(`select movie_title from submissions where id = 'sub-nul'`);
    expect(row!.movie_title).toBe("Ratatouille");
  });
});

test.describe("tampered moderation forms", () => {
  test("an unknown decision value is refused and leaves the submission pending", async ({ page, login }) => {
    await seedSubmission({ id: "sub-bogus", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Bogus decision" });
    await login();
    const pending = card(page, "Bogus decision");
    await pending.getByRole("button", { name: "Approve" }).evaluate((b) => ((b as HTMLButtonElement).value = "bogus"));
    await pending.getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=error/);

    const [row] = await query<{ status: string }>(`select status from submissions where id = 'sub-bogus'`);
    expect(row!.status).toBe("pending");
    expect(await query(`select 1 from review_actions where submission_id = 'sub-bogus'`)).toHaveLength(0);
  });
});
