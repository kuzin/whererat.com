import type { Page } from "@playwright/test";

export const PREFILL = "/submit?for=tt7200001&title=Form%20Test%20Movie&year=2003";

export type SubmitFields = {
  moment?: string;
  description?: string;
  name?: string;
  email?: string;
  optIn?: boolean;
  spoiler?: boolean;
};

/** Fills the anonymous submit form (movie preselected via the ?for= link). */
export async function fillSubmitForm(page: Page, f: SubmitFields = {}) {
  await page.getByLabel(/Name this moment/).fill(f.moment ?? "A rat on the shelf");
  await page.getByPlaceholder("Describe exactly where the rat appears and what it is doing.").fill(f.description ?? "A rat sprints across the top shelf.");
  await page.getByLabel(/Your name/).fill(f.name ?? "E2E Visitor");
  if (f.email !== undefined) await page.locator('input[name="submitterEmail"]').fill(f.email);
  if (f.optIn) await page.locator('input[name="marketingOptIn"]').check({ force: true });
  if (f.spoiler) await page.locator('input[name="spoiler"]').check({ force: true });
}

export async function submitForm(page: Page) {
  await page.getByRole("button", { name: "Submit for review" }).click();
}

/** Smallest valid PNG (1x1), for upload tests. */
export const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082",
  "hex",
);
