import { test, expect } from "../fixtures";
import "../config"; // sets SESSION_SECRET before the token helpers load
import { query } from "../support/db";
import { createOptInToken } from "../../src/lib/opt-in-token";

test.describe("double opt-in", () => {
  test("opening the link shows a confirm button and subscribes nobody until it is clicked", async ({ page }) => {
    await page.goto(`/confirm-subscription?token=${encodeURIComponent(createOptInToken("reader@example.com"))}`);
    await expect(page.getByRole("heading", { name: "Send me WhereRat updates?" })).toBeVisible();
    await expect(page.getByText("reader@example.com")).toBeVisible();
    // A mail scanner that merely GETs the link must not subscribe anyone.
    expect(await query(`select 1 from email_preferences`)).toHaveLength(0);

    await page.getByRole("button", { name: "Yes, subscribe me" }).click();
    await expect(page).toHaveURL(/status=ok/);
    await expect(page.getByRole("heading", { name: "You're subscribed" })).toBeVisible();

    const rows = await query<{ email: string; marketing_opt_in: boolean }>(`select email, marketing_opt_in from email_preferences`);
    expect(rows).toEqual([{ email: "reader@example.com", marketing_opt_in: true }]);
  });

  test("confirming twice is harmless", async ({ page }) => {
    const url = `/confirm-subscription?token=${encodeURIComponent(createOptInToken("twice@example.com"))}`;
    for (let i = 0; i < 2; i++) {
      await page.goto(url);
      await page.getByRole("button", { name: "Yes, subscribe me" }).click();
      await expect(page).toHaveURL(/status=ok/);
    }
    expect(await query(`select 1 from email_preferences where email = 'twice@example.com'`)).toHaveLength(1);
  });

  test("tampered, expired and junk tokens are rejected and offer no button", async ({ page }) => {
    const good = createOptInToken("victim@example.com");
    const [payload, sig] = good.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ e: "someone-else@example.com", x: 9_999_999_999 })).toString("base64url");
    const bad = [
      `${forgedPayload}.${sig}`,
      createOptInToken("old@example.com", Date.now() - 8 * 86_400_000),
      `${payload}.AAAA`,
      "garbage",
      "",
    ];
    for (const token of bad) {
      await page.goto(`/confirm-subscription?token=${encodeURIComponent(token)}`);
      await expect(page.getByRole("heading", { name: "Link not recognised" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Yes, subscribe me" })).toHaveCount(0);
    }
    expect(await query(`select 1 from email_preferences`)).toHaveLength(0);
  });

  test("posting a forged token straight to the action subscribes nobody", async ({ page }) => {
    await page.goto(`/confirm-subscription?token=${encodeURIComponent(createOptInToken("real@example.com"))}`);
    // Swap the token in the already-rendered form for a forged one, then submit it.
    await page.evaluate(() => {
      (document.querySelector('input[name="token"]') as HTMLInputElement).value = "forged.token";
    });
    await page.getByRole("button", { name: "Yes, subscribe me" }).click();
    await expect(page).toHaveURL(/status=invalid/);
    expect(await query(`select 1 from email_preferences`)).toHaveLength(0);
  });
});

test.describe("unsubscribing", () => {
  test("a valid unsubscribe link opts the address out", async ({ page }) => {
    await query(`insert into email_preferences (email, marketing_opt_in, unsubscribe_token) values ('leaver@example.com', true, 'unsub-token-1')`);
    await page.goto("/api/unsubscribe?token=unsub-token-1");
    await expect(page).toHaveURL(/\/unsubscribed\?status=ok/);
    await expect(page.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
    const [row] = await query<{ marketing_opt_in: boolean }>(`select marketing_opt_in from email_preferences where email = 'leaver@example.com'`);
    expect(row!.marketing_opt_in).toBe(false);
  });

  test("an unknown or missing token is a friendly no-op", async ({ page }) => {
    await query(`insert into email_preferences (email, marketing_opt_in, unsubscribe_token) values ('stay@example.com', true, 'unsub-token-2')`);
    for (const url of ["/api/unsubscribe?token=nope", "/api/unsubscribe"]) {
      await page.goto(url);
      await expect(page).toHaveURL(/\/unsubscribed\?status=invalid/);
      await expect(page.getByRole("heading", { name: "Link not recognised" })).toBeVisible();
    }
    const [row] = await query<{ marketing_opt_in: boolean }>(`select marketing_opt_in from email_preferences where email = 'stay@example.com'`);
    expect(row!.marketing_opt_in).toBe(true);
  });
});
