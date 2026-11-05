/** Stale tabs, double clicks and simultaneous moderators: what happens when two people (or one impatient one) act on the same item. */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { MOVIES, query, seedSubmission } from "../support/db";

const card = (page: Page, text: string) => page.locator("article", { hasText: text });

test.describe("stale moderation tabs", () => {
  test("approving the same sighting twice from two tabs is idempotent (one audit row, one movie, no error)", async ({ page, login, context }) => {
    await seedSubmission({ id: "sub-twice", movieTitle: "Twice Movie", imdbId: "tt7400001", movieYear: 2010, title: "Twice sighting" });
    await login();
    const staleTab = await context.newPage();
    await staleTab.goto("/moderation");
    await page.goto("/moderation");

    await card(page, "Twice sighting").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    // The other tab still shows it as pending and the moderator clicks Approve there too.
    await card(staleTab, "Twice sighting").getByRole("button", { name: "Approve" }).click();
    await expect(staleTab).toHaveURL(/toast=moderation-stale/);
    await expect(staleTab.getByText("Already handled").first()).toBeVisible();
    await expect(staleTab.getByText("Something went wrong")).toHaveCount(0);

    const audits = await query(`select 1 from review_actions where submission_id = 'sub-twice' and action = 'approved'`);
    expect(audits, "a second approval of an already-approved item must not be recorded again").toHaveLength(1);
    expect(await query(`select 1 from movies where imdb_id = 'tt7400001'`)).toHaveLength(1);
  });

  test("a stale 'Deny' can't unpublish a sighting that was already approved", async ({ page, login, context }) => {
    await seedSubmission({ id: "sub-flip", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Published then denied?" });
    await login();
    const staleTab = await context.newPage();
    await staleTab.goto("/moderation");
    await page.goto("/moderation");

    await card(page, "Published then denied?").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    await card(staleTab, "Published then denied?").getByRole("button", { name: "Deny" }).click();
    await expect(staleTab).toHaveURL(/toast=moderation-stale/);

    const [row] = await query<{ status: string }>(`select status from submissions where id = 'sub-flip'`);
    expect(row!.status, "an approved sighting must not silently become rejected").toBe("approved");
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Published then denied?").first()).toBeVisible();
  });

  test("an edit saved from a stale tab after approval doesn't send the sighting back to pending", async ({ page, login, context }) => {
    await seedSubmission({ id: "sub-edit-stale", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Edited from a stale tab" });
    await login();
    const staleTab = await context.newPage();
    await staleTab.goto("/moderation?edit=sub-edit-stale");

    await page.goto("/moderation");
    await card(page, "Edited from a stale tab").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    await staleTab.getByRole("button", { name: "Save edits" }).click(); // "edited" = keep pending
    await expect(staleTab).toHaveURL(/toast=moderation-stale/);
    const [row] = await query<{ status: string }>(`select status from submissions where id = 'sub-edit-stale'`);
    expect(row!.status, "saving a stale edit must not unpublish an approved sighting").toBe("approved");
  });
});

test.describe("simultaneous moderators", () => {
  test("two sightings for the same NEW title approved at the same moment end up on one movie", async ({ page, login, context }) => {
    await seedSubmission({ id: "sub-a", movieTitle: "Brand New Film", imdbId: "tt7400002", movieYear: 2024, title: "First sighting" });
    await seedSubmission({ id: "sub-b", movieTitle: "Brand New Film", imdbId: "tt7400002", movieYear: 2024, title: "Second sighting" });
    await login();
    const other = await context.newPage();
    await page.goto("/moderation");
    await other.goto("/moderation");

    await Promise.all([
      card(page, "First sighting").getByRole("button", { name: "Approve" }).click(),
      card(other, "Second sighting").getByRole("button", { name: "Approve" }).click(),
    ]);
    await Promise.all([page.waitForLoadState("networkidle"), other.waitForLoadState("networkidle")]);

    expect(await query(`select 1 from movies where imdb_id = 'tt7400002'`)).toHaveLength(1);
    const statuses = await query<{ status: string }>(`select status from submissions where id in ('sub-a','sub-b') order by id`);
    expect(statuses.map((s) => s.status)).toEqual(["approved", "approved"]);
    await page.goto("/movies/brand-new-film-2024");
    await expect(page.getByText("First sighting").first()).toBeVisible();
    await expect(page.getByText("Second sighting").first()).toBeVisible();
  });

  test("a rapid double-click on Approve records one decision", async ({ page, login }) => {
    await seedSubmission({ id: "sub-dbl", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Double clicked" });
    await login();
    const approve = card(page, "Double clicked").getByRole("button", { name: "Approve" });
    await approve.dblclick();
    await page.waitForLoadState("networkidle");
    const audits = await query(`select 1 from review_actions where submission_id = 'sub-dbl' and action = 'approved'`);
    expect(audits).toHaveLength(1);
  });
});

test.describe("re-review and permanent deletion", () => {
  test("sending an approved sighting back to pending unpublishes it; approving again republishes it", async ({ page, login }) => {
    await seedSubmission({ id: "sub-back", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Round trip", status: "approved" });
    await login();
    await page.goto("/moderation", { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /Approved/ }).click();
    await page.getByRole("button", { name: /Round trip/ }).click(); // history cards are collapsed accordions
    await page.getByRole("button", { name: "Re-review" }).click();
    await expect(page).toHaveURL(/toast=moderation-requeued/);
    const [row] = await query<{ status: string }>(`select status from submissions where id = 'sub-back'`);
    expect(row!.status).toBe("pending");

    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Round trip")).toHaveCount(0);

    await page.goto("/moderation");
    await card(page, "Round trip").getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await expect(page.getByText("Round trip").first()).toBeVisible();
  });
});
