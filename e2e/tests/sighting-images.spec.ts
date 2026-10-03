import { test, expect, MODERATOR } from "../fixtures";
import { MOVIES, query, seedSubmission } from "../support/db";

// Smallest valid PNG — the upload path checks the file's magic bytes, not just its MIME type.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function seedApproved(id: string, title: string, timestamp: string) {
  await seedSubmission({ id, movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title, timestamp, status: "approved" });
}

async function addImage(submissionId: string, url: string, sortOrder = 0) {
  await query(
    `insert into submission_images (submission_id, image_url, sort_order) values ($1, $2, $3)`,
    [submissionId, url, sortOrder],
  );
}

const imagesOf = (submissionId: string) =>
  query<{ image_url: string }>(
    `select image_url from submission_images where submission_id = $1 order by sort_order`,
    [submissionId],
  );

const row = (page: import("@playwright/test").Page, text: string) =>
  page.getByRole("listitem").filter({ hasText: text });

test.describe("sighting images", () => {
  test("lists every live sighting, filtered by whether it has images", async ({ page, login }) => {
    await seedApproved("sub-with", "Remy on the shelf", "10%");
    await addImage("sub-with", "/favicon.svg");
    await seedApproved("sub-without", "Emile in the rain", "20%");
    await seedSubmission({ id: "sub-pending", movieTitle: "Ratatouille", imdbId: MOVIES.ratatouille.imdbId, title: "Still pending" });
    await login(MODERATOR); // not just the owner

    await expect(page.getByText("1 of 2 live sightings have no images yet.")).toBeVisible();
    await page.getByRole("link", { name: "Manage images" }).click();
    await expect(page).toHaveURL(/\/moderation\/images\?filter=without$/);

    const filters = page.getByRole("navigation", { name: "Filter sightings by images" });
    await expect(filters.getByRole("link", { name: "All (2)" })).toBeVisible();
    await expect(filters.getByRole("link", { name: "Without images (1)" })).toHaveAttribute("aria-current", "page");
    await expect(row(page, "Emile in the rain")).toContainText("No images");
    await expect(row(page, "Remy on the shelf")).toHaveCount(0);
    await expect(page.getByText("Still pending")).toHaveCount(0);

    await filters.getByRole("link", { name: "With images (1)" }).click();
    await expect(row(page, "Remy on the shelf")).toContainText("1 image");
    await expect(row(page, "Emile in the rain")).toHaveCount(0);

    await page.getByRole("link", { name: "All (2)" }).click();
    await page.getByRole("searchbox", { name: "Search sightings" }).fill("emile");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=emile/);
    await expect(row(page, "Emile in the rain")).toBeVisible();
    await expect(row(page, "Remy on the shelf")).toHaveCount(0);
  });

  test("adds an image to one sighting, then Save & next moves on to the following one", async ({ page, login }) => {
    await seedApproved("sub-a", "First rat", "10%");
    await seedApproved("sub-b", "Second rat", "20%");
    await login();
    await page.goto("/moderation/images?filter=without");

    await row(page, "First rat").getByRole("link", { name: /Add images/ }).click();
    await expect(page.getByRole("heading", { name: "Images: First rat" })).toBeVisible();
    await expect(page.getByText("Sighting 1 of 2")).toBeVisible();
    await page.locator('input[type="file"]').first().setInputFiles({ name: "rat.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Save & next" }).click();

    await expect(page).toHaveURL(/edit=queue-sub-b/);
    await expect(page).toHaveURL(/toast=sighting-images-saved/);
    await expect(page.getByRole("heading", { name: "Images: Second rat" })).toBeVisible();

    const saved = await imagesOf("sub-a");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.image_url).toMatch(/^\/uploads\/sightings\/[\w-]+\.png$/);
    // Only the images changed: still approved, no new review entry (so no "approved" e-mail).
    expect(await query(`select status from submissions where id = 'sub-a'`)).toEqual([{ status: "approved" }]);
    expect(await query(`select 1 from review_actions`)).toHaveLength(0);

    // The last sighting in the list has nothing to move on to.
    await expect(page.getByRole("button", { name: "Save & next" })).toHaveCount(0);
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: /^Images:/ })).toHaveCount(0);
    await expect(row(page, "First rat")).toHaveCount(0); // it has an image now
  });

  test("removing every image leaves the sighting without images", async ({ page, login }) => {
    await seedApproved("sub-img", "Rat with a photo", "30%");
    await addImage("sub-img", "/favicon.svg");
    await login();
    await page.goto("/moderation/images");

    await row(page, "Rat with a photo").getByRole("link", { name: /Edit images/ }).click();
    await page.getByRole("button", { name: "Remove image" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page).toHaveURL(/toast=sighting-images-saved/);
    expect(await imagesOf("sub-img")).toHaveLength(0);
    await expect(row(page, "Rat with a photo")).toContainText("No images");
  });

  test("an image URL swapped into the form is not stored", async ({ page, login }) => {
    await seedApproved("sub-forge", "Forged rat", "40%");
    await addImage("sub-forge", "/favicon.svg");
    await login();
    await page.goto("/moderation/images");

    await row(page, "Forged rat").getByRole("link", { name: /Edit images/ }).click();
    await expect(page.getByRole("heading", { name: "Images: Forged rat" })).toBeVisible();
    await page.evaluate(() => {
      (document.querySelector('input[name="sightingImageUrl"]') as HTMLInputElement).value =
        "https://evil.example/pixel.gif";
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page).toHaveURL(/toast=sighting-images-saved/);
    expect(await imagesOf("sub-forge")).toEqual([]);
  });

  test("signed-out visitors are sent to log in", async ({ page }) => {
    await page.goto("/moderation/images");
    await expect(page).toHaveURL(/\/login\?next=%2Fmoderation%2Fimages|\/login\?next=\/moderation\/images/);
  });
});
