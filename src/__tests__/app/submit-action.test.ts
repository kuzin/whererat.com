/**
 * The public web server action `submitSighting` (src/app/submit/actions.ts):
 * the only place where `autoApprove` has any effect, and only for a verified
 * moderator session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT:${url}`);
    }
  }
  return {
    RedirectSignal,
    session: undefined as undefined | { id: string; name: string; username: string; email: string; role: "owner" | "moderator" },
    xff: undefined as string | undefined,
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (n: string) => (n === "x-forwarded-for" ? (h.xff ?? null) : null) })),
  cookies: vi.fn(async () => ({ get: () => ({ value: "cookie" }) })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("@/lib/auth", () => ({
  MODERATOR_SESSION_COOKIE: "whererat_moderator",
  parseModeratorSession: vi.fn(() => h.session),
  canAutoApproveSubmissions: vi.fn((s: unknown) => Boolean(s)),
}));
// Privileged actions now verify the account behind the cookie. These tests drive the
// session through the mocked parseModeratorSession, so delegate to it (the real
// account re-check is covered in moderator-session.test.ts).
vi.mock("@/lib/moderator-session", async () => {
  const auth = await import("@/lib/auth");
  return { verifyModeratorSession: async (value: string | undefined) => auth.parseModeratorSession(value) };
});

vi.mock("@/lib/public-sighting-submit", () => ({ executePublicSightingSubmit: vi.fn() }));
vi.mock("@/lib/moderation-store", () => ({ reviewSubmission: vi.fn().mockResolvedValue(undefined) }));

import { submitSighting } from "@/app/submit/actions";
import { executePublicSightingSubmit } from "@/lib/public-sighting-submit";
import { reviewSubmission } from "@/lib/moderation-store";

const mockExec = vi.mocked(executePublicSightingSubmit);
const mockReview = vi.mocked(reviewSubmission);

const MOD = { id: "m", name: "Mo", username: "mo", email: "m@x.io", role: "moderator" as const };

async function run(entries: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  try {
    await submitSighting(fd);
    return undefined;
  } catch (e) {
    if (e instanceof h.RedirectSignal) return e.url;
    throw e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = undefined;
  h.xff = "198.51.100.7";
  mockExec.mockResolvedValue({ ok: true, submissionId: "sub-9" });
  mockReview.mockResolvedValue({ applied: true });
});

describe("submitSighting: autoApprove", () => {
  it("an anonymous visitor posting autoApprove=on is just queued", async () => {
    const url = await run({ autoApprove: "on" });
    expect(url).toBe("/submit?status=queued");
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledWith(expect.any(FormData), "198.51.100.7", { skipModerationNotify: false });
  });

  it("a moderator with autoApprove=on is approved by that moderator and the owner e-mail is skipped", async () => {
    h.session = MOD;
    const url = await run({ autoApprove: "on" });
    expect(url).toBe("/submit?status=approved");
    expect(mockReview).toHaveBeenCalledExactlyOnceWith({ submissionId: "sub-9", decision: "approved", moderator: MOD });
    expect(mockExec).toHaveBeenCalledWith(expect.any(FormData), "198.51.100.7", { skipModerationNotify: true });
  });

  it("a moderator WITHOUT the checkbox is queued like anyone else", async () => {
    h.session = MOD;
    expect(await run()).toBe("/submit?status=queued");
    expect(mockReview).not.toHaveBeenCalled();
  });

  it.each(["true", "1", "ON", "yes", ""])("autoApprove=%j is not 'on' and does nothing, even for a moderator", async (v) => {
    h.session = MOD;
    expect(await run({ autoApprove: v })).toBe("/submit?status=queued");
    expect(mockReview).not.toHaveBeenCalled();
  });

  it("a failed submission is never auto-approved (no id to approve)", async () => {
    h.session = MOD;
    mockExec.mockResolvedValueOnce({ ok: false, code: "missing" });
    expect(await run({ autoApprove: "on" })).toBe("/submit?status=missing");
    expect(mockReview).not.toHaveBeenCalled();
  });
});

describe("submitSighting: failure mapping and IP", () => {
  it.each([
    [{ ok: false as const, code: "rate-limited" as const }, "/submit?status=rate-limited"],
    [{ ok: false as const, code: "no-imdb" as const }, "/submit?status=no-imdb"],
    [{ ok: false as const, code: "missing" as const }, "/submit?status=missing"],
    [{ ok: false as const, code: "server-error" as const, message: "connection to server at ep-x.neon.tech failed" }, "/submit?status=missing"],
  ])("%o -> %s (internal error text never reaches the URL)", async (result, expected) => {
    mockExec.mockResolvedValueOnce(result);
    const url = await run();
    expect(url).toBe(expected);
    expect(url).not.toMatch(/neon|connection/);
  });

  it("uses the first x-forwarded-for hop, 'unknown' when absent", async () => {
    h.xff = " 203.0.113.9 , 10.0.0.1";
    await run();
    expect(mockExec.mock.calls[0]![1]).toBe("203.0.113.9");
    h.xff = undefined;
    await run();
    expect(mockExec.mock.calls[1]![1]).toBe("unknown");
  });

  it("a catalog match slug is appended as &match=", async () => {
    mockExec.mockResolvedValueOnce({ ok: true, submissionId: "sub-9", catalogMatchSlug: "ratatouille-2007" });
    expect(await run()).toBe("/submit?status=queued&match=ratatouille-2007");
  });
});
