/** Automated accessibility scans (axe-core, WCAG 2.1 A/AA) of the pages people actually use. */
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../fixtures";
import { MOVIES, SERIES, query, seedNews, seedSeries, seedSightings } from "../support/db";

/**
 * Known issues, each pinned by a test.fail() below so it flips red when fixed:
 *  - colour contrast: secondary text uses text-stone-400 (≈2.1–2.6:1 on light backgrounds), the
 *    primary buttons are white on #ea580c / #f54900 (≈3.6:1), and the footer icons are low-contrast.
 *    WCAG AA needs 4.5:1. Checked per page in "colour contrast" below.
 *  - labels: the rat-count number input and the visually hidden file input have no accessible name.
 * Everything else stays guarded on every page.
 */
const KNOWN_LABEL = /name="approximateRatCount"|type="file"/;

async function scan(page: import("@playwright/test").Page, { only }: { only?: "contrast" | "label" } = {}) {
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (!only) builder.disableRules(["color-contrast"]);
  const raw = await builder.analyze();
  return raw.violations
    .map((v) => ({
      ...v,
      nodes: v.nodes.filter((n) => {
        if (only === "contrast") return v.id === "color-contrast";
        if (only === "label") return v.id === "label" && KNOWN_LABEL.test(n.html);
        return !(v.id === "label" && KNOWN_LABEL.test(n.html));
      }),
    }))
    .filter((v) => v.nodes.length > 0)
    .map((v) => {
      const n = v.nodes[0]!;
      const d = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number };
      const colors = d.contrastRatio ? ` [${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}]` : "";
      return `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}× e.g. ${n.target.join(" ")})${colors}`;
    });
}

async function seed() {
  await seedSeries();
  await seedSightings(MOVIES.ratatouille, 4);
  await seedSightings(SERIES, 3, { kind: "series" });
  await seedNews([{ id: "n-1", title: "Welcome", body: "Hello **world**", type: "announcement" }]);
}

for (const [name, path] of [
  ["home", "/"],
  ["movie page", `/movies/${MOVIES.ratatouille.slug}`],
  ["show page", `/shows/${SERIES.slug}`],
  ["submit form", "/submit?for=tt7200001&title=Form%20Test%20Movie&year=2003"],
  ["news", "/news"],
  ["login", "/login"],
  ["about", "/about"],
  ["guidelines", "/guidelines"],
  ["privacy", "/privacy"],
] as const) {
  test(`${name} has no WCAG A/AA violations`, async ({ page }) => {
    await seed();
    await page.goto(path, { waitUntil: "networkidle" });
    expect(await scan(page)).toEqual([]);
  });
}

test("moderation queue and edit modal have no WCAG A/AA violations", async ({ page, login }) => {
  await seed();
  await query(
    `insert into submissions (id, movie_title, movie_year, imdb_id, imdb_kind, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by)
     values ('p1','Ratatouille',2007,$1,'movie','10%','Pending one','Seen in the kitchen.',false,1,'pending','t')`,
    [MOVIES.ratatouille.imdbId],
  );
  await login();
  await page.goto("/moderation", { waitUntil: "networkidle" });
  expect(await scan(page)).toEqual([]);
  await page.goto("/moderation?edit=p1", { waitUntil: "networkidle" });
  expect(await scan(page)).toEqual([]);
});

test("the form is operable by keyboard alone (tab order reaches submit)", async ({ page }) => {
  await page.goto("/submit?for=tt7200001&title=Form%20Test%20Movie&year=2003");
  await page.getByLabel(/Name this moment/).focus();
  const reached: string[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? ""}` : "";
    });
    reached.push(label);
    if (/Submit for review/.test(label)) break;
  }
  expect(reached.some((l) => /Submit for review/.test(l)), `tab order: ${reached.join(" | ")}`).toBe(true);
});

test.describe("known accessibility issues (expected to fail until fixed)", () => {
  for (const [name, path] of [
    ["home", "/"],
    ["movie page", `/movies/${MOVIES.ratatouille.slug}`],
    ["submit form", "/submit?for=tt7200001&title=Form%20Test%20Movie&year=2003"],
    ["news", "/news"],
    ["about", "/about"],
  ] as const) {
    test(`${name}: text meets 4.5:1 colour contrast`, async ({ page }) => {
      test.fail(true, "low-contrast secondary text (text-stone-400) and orange buttons — see KNOWN notes");
      await seed();
      await page.goto(path, { waitUntil: "networkidle" });
      expect(await scan(page, { only: "contrast" })).toEqual([]);
    });
  }

  test("the rat-count and photo-upload inputs have accessible names", async ({ page }) => {
    test.fail(true, "input[name=approximateRatCount] and the sr-only file input have no label");
    await page.goto("/submit?for=tt7200001&title=Form%20Test%20Movie&year=2003", { waitUntil: "networkidle" });
    expect(await scan(page, { only: "label" })).toEqual([]);
  });
});
