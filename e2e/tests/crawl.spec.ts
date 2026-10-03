/**
 * Bug-hunting crawler: visits real pages with realistic data and fails on anything a
 * user would notice but a targeted test would miss — console errors, uncaught
 * exceptions, failed requests, broken images, dead internal links, and horizontal
 * scrolling on a phone.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { MOVIES, SERIES, query, seedNews, seedSeries, seedSightings } from "../support/db";

async function seedRichData() {
  await seedSeries();
  await seedSightings(MOVIES.ratatouille, 7);
  await seedSightings(MOVIES.downton, 3, { spoiler: true });
  await seedSightings(SERIES, 6, { kind: "series" });
  await seedNews([
    { id: "n-1", title: "Welcome to WhereRat", body: "We **catalog** rats.\n\n- one\n- two", type: "announcement" },
    { id: "n-2", title: "Community picks", body: "Great finds this week.", type: "community" },
    { id: "n-3", title: "Unpublished draft", body: "Secret", published: false },
  ]);
}

type Problems = string[];

function watch(page: Page): Problems {
  const problems: Problems = [];
  page.on("console", (m) => {
    // The resource-failed console line has no URL; the response listener below names it.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message.slice(0, 200)}`));
  page.on("response", (r) => {
    const url = r.url();
    // Vercel Analytics / Speed Insights scripts only exist on Vercel itself.
    if (url.includes("/_vercel/")) return;
    if (r.status() >= 400 && url.startsWith("http://127.0.0.1")) problems.push(`HTTP ${r.status()}: ${url}`);
  });
  page.on("requestfailed", (r) => {
    // Aborted navigations between pages are noise; real failures aren't.
    if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
  });
  return problems;
}

async function brokenImages(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const imgs = [...document.images].filter((i) => i.getBoundingClientRect().width > 0);
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); }))));
    return imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src);
  });
}

const PUBLIC_PAGES = [
  "/", "/?q=rat", "/?genre=Drama", "/?rodent=mouse", "/news", "/about", "/guidelines", "/privacy", "/submit",
  `/movies/${MOVIES.ratatouille.slug}`, `/movies/${MOVIES.downton.slug}`, `/shows/${SERIES.slug}`, "/login",
];

test.describe("public pages are clean", () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path}: no console errors, failed requests or broken images`, async ({ page }) => {
      await seedRichData();
      const problems = watch(page);
      await page.goto(path, { waitUntil: "networkidle" });
      const broken = await brokenImages(page);
      expect(broken, `broken images on ${path}`).toEqual([]);
      expect(problems, `problems on ${path}`).toEqual([]);
    });
  }
});

test.describe("moderator pages are clean", () => {
  test("queue, history tabs, users, news and profile load without errors", async ({ page, login }) => {
    await seedRichData();
    await query(
      `insert into submissions (id, movie_title, movie_year, imdb_id, imdb_kind, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by)
       values ('p1','Ratatouille',2007,$1,'movie','10%','Pending one','d',false,1,'pending','t'),
              ('r1','Ratatouille',2007,$1,'movie','20%','Rejected one','d',false,1,'rejected','t')`,
      [MOVIES.ratatouille.imdbId],
    );
    await login();
    const problems = watch(page);
    for (const path of ["/moderation", "/moderation/users", "/moderation/news", "/profile", `/movies/${MOVIES.ratatouille.slug}`]) {
      await page.goto(path, { waitUntil: "networkidle" });
      expect(await brokenImages(page), `broken images on ${path}`).toEqual([]);
    }
    // the history tabs on the queue page
    await page.goto("/moderation", { waitUntil: "networkidle" });
    for (const tab of [/Approved/, /Denied/]) {
      await page.getByRole("tab", { name: tab }).click().catch(() => page.getByText(tab).first().click());
    }
    expect(problems).toEqual([]);
  });
});

test.describe("every internal link on the main pages resolves", () => {
  test("home, a movie, a show and news: no dead internal links", async ({ page, request }) => {
    await seedRichData();
    const seen = new Set<string>();
    const dead: string[] = [];
    for (const start of ["/", `/movies/${MOVIES.ratatouille.slug}`, `/shows/${SERIES.slug}`, "/news", "/submit"]) {
      await page.goto(start, { waitUntil: "networkidle" });
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
      for (const href of hrefs) {
        if (!href.startsWith("/") || href.startsWith("//") || seen.has(href)) continue;
        seen.add(href);
        const res = await request.get(href, { maxRedirects: 5 });
        if (res.status() >= 400) dead.push(`${res.status()} ${href} (from ${start})`);
      }
    }
    expect(dead).toEqual([]);
  });
});

test.describe("phones: nothing overflows horizontally", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  for (const path of ["/", "/submit", "/news", "/login", `/movies/${MOVIES.ratatouille.slug}`, `/shows/${SERIES.slug}`]) {
    test(`${path} fits a 375px screen`, async ({ page }) => {
      await seedRichData();
      await page.goto(path, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const wide = [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(el).position !== "fixed")
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
        return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, wide };
      });
      expect(overflow.scrollWidth, `page scrolls sideways; widest: ${overflow.wide.join(", ")}`).toBeLessThanOrEqual(overflow.innerWidth + 1);
    });
  }

  test("moderation queue fits a phone", async ({ page, login }) => {
    await seedRichData();
    await query(
      `insert into submissions (id, movie_title, movie_year, imdb_id, imdb_kind, timestamp_code, title, description, spoiler, approximate_rat_count, status, submitted_by)
       values ('p1','Ratatouille',2007,$1,'movie','10%','A pending sighting with a rather long headline that goes on and on','A long description '||repeat('word ',60),false,1,'pending','someone')`,
      [MOVIES.ratatouille.imdbId],
    );
    await login();
    await page.goto("/moderation", { waitUntil: "networkidle" });
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  });
});
