import { rm } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../fixtures";
import { MOVIES, query } from "../support/db";
import { PNG_1x1, PREFILL, fillSubmitForm, submitForm } from "../support/submit";

test.describe("submitting a sighting", () => {
  test("a visitor can submit and the moderator then sees it in the queue", async ({ page, login }) => {
    await page.goto(PREFILL);
    await fillSubmitForm(page, { moment: "A rat on the shelf", description: "A rat sprints across the top shelf.", email: "visitor@example.com" });
    await submitForm(page);
    await expect(page).toHaveURL(/status=queued/);

    const [row] = await query<Record<string, unknown>>(`select * from submissions`);
    expect(row).toMatchObject({
      movie_title: "Form Test Movie",
      imdb_id: "tt7200001",
      movie_year: 2003,
      title: "A rat on the shelf",
      status: "pending",
      submitted_by: "E2E Visitor",
      submitter_email: "visitor@example.com",
    });

    await login();
    await expect(page.locator("article", { hasText: "A rat on the shelf" })).toBeVisible();
  });

  test("required fields are checked in the browser and nothing is sent", async ({ page }) => {
    await page.goto(PREFILL);
    await submitForm(page);
    await expect(page.getByText("Sighting title is required.").first()).toBeVisible();
    await expect(page.getByText("Description is required.").first()).toBeVisible();
    await expect(page.getByText("Your name is required.").first()).toBeVisible();
    await expect(page).not.toHaveURL(/status=/);
    expect(await query(`select 1 from submissions`)).toHaveLength(0);
  });

  test("a malformed email address is rejected inline", async ({ page }) => {
    await page.goto(PREFILL);
    await fillSubmitForm(page, { email: "not-an-email" });
    await submitForm(page);
    await expect(page.getByText("Enter a valid email address or leave it blank.").first()).toBeVisible();
    expect(await query(`select 1 from submissions`)).toHaveLength(0);
  });

  test("without a selected movie it asks you to pick one", async ({ page }) => {
    await page.goto("/submit");
    await fillSubmitForm(page);
    await submitForm(page);
    await expect(page.getByText(/Select a movie from search|Pick a result from the search/).first()).toBeVisible();
    expect(await query(`select 1 from submissions`)).toHaveLength(0);
  });

  test("ticking the newsletter box stores nothing: subscribing needs the e-mailed confirmation", async ({ page }) => {
    await page.goto(PREFILL);
    await fillSubmitForm(page, { email: "someone@example.com", optIn: true });
    await submitForm(page);
    await expect(page).toHaveURL(/status=queued/);
    expect(await query(`select 1 from email_preferences`)).toHaveLength(0);
  });

  test("an attached image is stored; an HTML file renamed .png is rejected but the sighting still saves", async ({ page }) => {
    await page.goto(PREFILL);
    await fillSubmitForm(page);
    await page.locator('input[type="file"]').setInputFiles([
      { name: "rat.png", mimeType: "image/png", buffer: PNG_1x1 },
      { name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") },
    ]);
    await submitForm(page);
    await expect(page).toHaveURL(/status=queued/);

    const images = await query<{ image_url: string }>(`select image_url from submission_images`);
    expect(images).toHaveLength(1);
    expect(images[0]!.image_url).toMatch(/^\/uploads\/sightings\/[0-9a-f-]{36}\.png$/);
    await rm(path.join(process.cwd(), "public", images[0]!.image_url), { force: true });
  });
});

test.describe("hostile input", () => {
  test("tampered hidden fields are sanitized on the server", async ({ page }) => {
    await page.goto(PREFILL);
    await fillSubmitForm(page);
    await page.evaluate(() => {
      const form = [...document.forms].find((f) => f.querySelector("[name=sightingTitle]"))!;
      const set = (n: string, v: string) => ((form.elements.namedItem(n) as HTMLInputElement).value = v);
      set("movieYear", "3000"); // outside the DB's 1801–2999 check
      set("moviePosterUrl", "https://evil.example/tracker.png");
      set("sightingTitle", "Tamper\u0000 title");
      const rodent = (form.elements.namedItem("rodentTypes") as RadioNodeList)[0] as HTMLInputElement;
      rodent.value = "dragon";
      rodent.checked = true;
    });
    await submitForm(page);
    await expect(page).toHaveURL(/status=queued/);

    const [row] = await query<Record<string, unknown>>(`select * from submissions`);
    expect(row!.movie_year).toBeNull();
    expect(row!.movie_poster_url).toBeNull();
    expect(row!.title).toBe("Tamper title");
    expect(row!.rodent_types).toEqual(["rat"]);
  });

  test("hostile markdown can't run script or load an external tracker, in the preview or once published", async ({ page, login }) => {
    const hostile = [
      "![tracker](http://evil.example/p.png)",
      "<script>window.__pwned = 1</script>",
      "<img src=x onerror=\"window.__pwned = 2\">",
      "[click](javascript:window.__pwned=3)",
    ].join("\n\n");

    // 1. live preview on the form
    await page.goto(PREFILL);
    await fillSubmitForm(page, { description: hostile });
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.locator('img[src*="evil.example"]')).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    // 2. submit, approve, and view the public page
    await submitForm(page);
    await expect(page).toHaveURL(/status=queued/);
    await login();
    await page.locator("article", { hasText: "A rat on the shelf" }).getByRole("button", { name: "Approve" }).click();
    await expect(page).toHaveURL(/toast=moderation-approved/);

    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/movies/form-test-movie-2003");
    await expect(page.getByText("A rat on the shelf").first()).toBeVisible();
    await expect(page.locator('img[src*="evil.example"]')).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    expect(requests.filter((u) => u.includes("evil.example"))).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  test("an enormous description is capped rather than stored whole", async ({ page }) => {
    await page.goto(PREFILL);
    await fillSubmitForm(page);
    await page.getByPlaceholder("Describe exactly where the rat appears").fill("x".repeat(200_000));
    await submitForm(page);
    await expect(page).toHaveURL(/status=queued/);
    const [row] = await query<{ len: number }>(`select length(description) as len from submissions`);
    expect(row!.len).toBeLessThanOrEqual(10_000);
  });
});

test.describe("rate limiting", () => {
  test("the 6th submission from one address in an hour is refused", async ({ page }) => {
    for (let i = 1; i <= 5; i++) {
      await page.goto(`/submit?for=tt721000${i}&title=Limit%20Movie%20${i}&year=2003`);
      await fillSubmitForm(page, { moment: `Rate test ${i}` });
      await submitForm(page);
      await expect(page).toHaveURL(/status=queued/);
    }
    await page.goto("/submit?for=tt7210009&title=Limit%20Movie%206&year=2003");
    await fillSubmitForm(page, { moment: "Rate test 6" });
    await submitForm(page);
    await expect(page).toHaveURL(/status=rate-limited/);
    expect(await query(`select 1 from submissions`)).toHaveLength(5);
    const [bucket] = await query<{ count: number }>(`select count from rate_limits where key like 'submit:%'`);
    expect(bucket!.count).toBe(6);
  });
});

test.describe("what the catalog link pre-selects", () => {
  test("a movie page's 'Submit a Sighting' link opens the form with that movie chosen", async ({ page }) => {
    await page.goto(`/movies/${MOVIES.ratatouille.slug}`);
    await page.getByRole("link", { name: "Submit a Sighting" }).first().click();
    await expect(page).toHaveURL(/\/submit\?for=tt0382932/);
    await expect(page.getByText("Ratatouille").first()).toBeVisible();
  });
});
