/**
 * notifyOwnerOfNewSubmission: recipient selection, one-mail-per-moderator,
 * escaping, subject construction and failure isolation. Resend is mocked at
 * the sendBrandedEmail boundary; the DB is a fake pool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDbPool: () => ({ query: h.query }) }));
vi.mock("@/lib/email-send", () => ({ sendBrandedEmail: h.send }));

import { notifyOwnerOfNewSubmission } from "@/lib/moderation-notify";
import type { Submission } from "@/lib/whererat";

function submission(over: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1",
    movieTitle: "Ratatouille",
    movieYear: 2007,
    timestamp: "42%",
    title: "Remy in the kitchen",
    description: "Remy appears behind the stove.",
    spoiler: false,
    approximateRatCount: 3,
    status: "pending",
    submittedBy: "Alice",
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
const savedSite = process.env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  h.query.mockReset();
  h.send.mockReset();
  h.send.mockResolvedValue(undefined);
  h.query.mockResolvedValue({ rows: [{ email: "owner@x.com" }, { email: "mod@x.com" }] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.NEXT_PUBLIC_SITE_URL;
});
afterEach(() => {
  warn.mockRestore();
  if (savedSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = savedSite;
});

const sent = () => h.send.mock.calls.map(([arg]) => arg as { to: string; subject: string; html: string; text: string; logTag: string });

describe("recipients", () => {
  it("queries owners and moderators only", async () => {
    await notifyOwnerOfNewSubmission(submission());
    const sql = String(h.query.mock.calls[0]![0]);
    expect(sql).toMatch(/from accounts/i);
    expect(sql).toMatch(/role in \('owner', 'moderator'\)/);
  });

  it("sends one separate email per moderator (addresses are not shared in To)", async () => {
    await notifyOwnerOfNewSubmission(submission());
    expect(sent().map((s) => s.to)).toEqual(["owner@x.com", "mod@x.com"]);
    for (const s of sent()) {
      expect(s.to).not.toContain(",");
      expect(s.html).not.toContain("mod@x.com");
    }
  });

  it("tags sends for the logs", async () => {
    await notifyOwnerOfNewSubmission(submission());
    expect(sent().every((s) => s.logTag === "moderation-notify")).toBe(true);
  });

  it("drops blank/whitespace/null emails", async () => {
    h.query.mockResolvedValue({ rows: [{ email: "" }, { email: "   " }, { email: null }, { email: "ok@x.com" }] });
    await notifyOwnerOfNewSubmission(submission());
    expect(sent().map((s) => s.to)).toEqual(["ok@x.com"]);
  });

  it("does nothing (and warns) when there are no moderators", async () => {
    h.query.mockResolvedValue({ rows: [] });
    await expect(notifyOwnerOfNewSubmission(submission())).resolves.toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("swallows a DB failure so public submissions never break", async () => {
    h.query.mockRejectedValue(new Error("db down"));
    await expect(notifyOwnerOfNewSubmission(submission())).resolves.toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("content", () => {
  it("subject uses the sighting title", async () => {
    await notifyOwnerOfNewSubmission(submission());
    expect(sent()[0]!.subject).toBe("New sighting: Remy in the kitchen");
  });

  it("falls back to 'Movie (year)' when there is no title", async () => {
    await notifyOwnerOfNewSubmission(submission({ title: undefined }));
    expect(sent()[0]!.subject).toBe("New sighting: Ratatouille (2007)");
    h.send.mockClear();
    await notifyOwnerOfNewSubmission(submission({ title: "   ", movieYear: undefined }));
    expect(sent()[0]!.subject).toBe("New sighting: Ratatouille");
  });

  it("adds the episode context for series with season and episode", async () => {
    await notifyOwnerOfNewSubmission(
      submission({ title: undefined, imdbKind: "series", seasonNumber: 2, episodeNumber: 5, episodeTitle: "Pilot" }),
    );
    expect(sent()[0]!.subject).toBe("New sighting: Ratatouille (2007) — S2E5: Pilot");
    expect(sent()[0]!.html).toContain("Point in episode");
  });

  it("omits episode context for series missing numbers, and for movies", async () => {
    await notifyOwnerOfNewSubmission(submission({ title: undefined, imdbKind: "series", seasonNumber: 2 }));
    expect(sent()[0]!.subject).not.toContain("S2E");
    h.send.mockClear();
    await notifyOwnerOfNewSubmission(submission({ title: undefined, imdbKind: "movie", seasonNumber: 2, episodeNumber: 3 }));
    expect(sent()[0]!.subject).not.toContain("S2E3");
    expect(sent()[0]!.html).toContain("Point in film");
  });

  it("includes count, submitter (+ email when given), IMDb id, spoiler flag and description", async () => {
    await notifyOwnerOfNewSubmission(
      submission({
        submitterEmail: "alice@example.com",
        imdbId: "tt0382932",
        spoiler: true,
        rodentTypes: ["mouse"],
        approximateRatCount: 2,
      }),
    );
    const { html, text } = sent()[0]!;
    for (const body of [html, text]) {
      expect(body).toContain("Approx. 2 mice");
      expect(body).toContain("Alice");
      expect(body).toContain("alice@example.com");
      expect(body).toContain("tt0382932");
      expect(body).toContain("Remy appears behind the stove.");
    }
    expect(text).toContain("Spoiler: Yes");
  });

  it("omits optional rows when absent", async () => {
    await notifyOwnerOfNewSubmission(submission());
    const { text } = sent()[0]!;
    expect(text).not.toContain("Spoiler:");
    expect(text).not.toContain("IMDb:");
    expect(text).toMatch(/^Submitted by: Alice$/m);
  });

  it("links to the moderation queue on the configured site URL", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://stage.example";
    await notifyOwnerOfNewSubmission(submission());
    expect(sent()[0]!.html).toContain('href="https://stage.example/moderation"');
    expect(sent()[0]!.text).toContain("https://stage.example/moderation");
  });

  it("defaults the link to whererat.com", async () => {
    await notifyOwnerOfNewSubmission(submission());
    expect(sent()[0]!.text).toContain("https://whererat.com/moderation");
  });

  it("attaches submitted images to the HTML and mentions them in text", async () => {
    await notifyOwnerOfNewSubmission(
      submission({ images: [{ url: "https://img/a.png", alt: "A" }, { url: "https://img/b.png" }] }),
    );
    expect(sent()[0]!.html).toContain("https://img/a.png");
    expect(sent()[0]!.text).toContain("2 images attached");
  });

  it("no image block when there are no images", async () => {
    await notifyOwnerOfNewSubmission(submission({ images: [] }));
    expect(sent()[0]!.text).not.toContain("image");
  });

  it("escapes hostile submitter-controlled fields in the HTML body", async () => {
    const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    await notifyOwnerOfNewSubmission(
      submission({
        title: evil,
        movieTitle: evil,
        description: evil,
        submittedBy: evil,
        submitterEmail: evil,
        episodeTitle: evil,
        images: [{ url: `x"><script>1</script>`, alt: evil }],
      }),
    );
    const { html } = sent()[0]!;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;script&gt;");
  });

  it.fails("BUG: a CR/LF in the public sighting title ends up in the Subject header (submitter-notify strips it, this path does not)", async () => {
    await notifyOwnerOfNewSubmission(submission({ title: "Nice rat\r\nBcc: attacker@evil.example" }));
    expect(sent()[0]!.subject).not.toMatch(/[\r\n]/);
  });
});
