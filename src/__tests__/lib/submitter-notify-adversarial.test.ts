/**
 * The receipt / decision e-mails are sent to an address the *public submitter*
 * typed in, containing text the submitter typed in. Uses the real
 * submitter-notify + email-template; sending, auth and the subscriber lookup
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/email-send", () => ({ sendBrandedEmail: vi.fn() }));
vi.mock("@/lib/email-preferences-store", () => ({ getSubscriber: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getModeratorAccounts: vi.fn(() => [{ id: "admin", email: "Admin@WhereRat.com" }]),
}));

import { notifySubmitterOfReceipt, notifySubmitterOfDecision } from "@/lib/submitter-notify";
import { sendBrandedEmail } from "@/lib/email-send";
import { getSubscriber } from "@/lib/email-preferences-store";
import type { Submission } from "@/lib/whererat";

const mockSend = vi.mocked(sendBrandedEmail);
const mockSubscriber = vi.mocked(getSubscriber);

const sub = (over: Partial<Submission> = {}): Submission => ({
  id: "s1",
  movieTitle: "Ratatouille",
  movieYear: 2007,
  timestamp: "42%",
  title: "Rat in kitchen",
  description: "Remy.",
  spoiler: false,
  approximateRatCount: 1,
  status: "pending",
  submittedBy: "Alice Liddell",
  submitterEmail: "alice@example.com",
  submittedAt: new Date(0),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset().mockResolvedValue(undefined);
  mockSubscriber.mockReset().mockResolvedValue(undefined);
});

describe("notifySubmitterOfReceipt", () => {
  it("sends one e-mail to the trimmed submitter address", async () => {
    await notifySubmitterOfReceipt(sub({ submitterEmail: "  alice@example.com " }));
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0]![0].to).toBe("alice@example.com");
  });

  it.each([undefined, "", "   "])("no address (%j) -> nothing sent", async (submitterEmail) => {
    await notifySubmitterOfReceipt(sub({ submitterEmail }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never mails moderator addresses (case-insensitive) even if a submitter types one", async () => {
    await notifySubmitterOfReceipt(sub({ submitterEmail: "ADMIN@whererat.com" }));
    await notifySubmitterOfDecision(sub({ submitterEmail: "admin@whererat.com" }), "approved");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("HTML in the submitter's name / title / movie is escaped in the HTML body", async () => {
    const payload = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    await notifySubmitterOfReceipt(sub({ submittedBy: payload, title: payload, movieTitle: payload }));
    const { html } = mockSend.mock.calls[0]![0];
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML in a rejected/approved e-mail is escaped too", async () => {
    const payload = `"><svg onload=alert(1)>`;
    await notifySubmitterOfDecision(sub({ submittedBy: payload, title: payload }), "rejected");
    await notifySubmitterOfDecision(sub({ submittedBy: payload, title: payload }), "approved");
    for (const [{ html }] of mockSend.mock.calls) expect(html).not.toContain("<svg onload");
  });

  it("BUG (hardening): CR/LF in the submitter's sighting title is copied into the e-mail Subject header", async () => {
    await notifySubmitterOfReceipt(sub({ title: "Hello\r\nBcc: victim@example.com" }));
    expect(mockSend.mock.calls[0]![0].subject).not.toMatch(/[\r\n]/);
  });

  it("BUG: the opted-in-subscriber footer is HTML but gets HTML-escaped, so the receipt shows raw '<br><span …>' text and the Unsubscribe link is not clickable", async () => {
    mockSubscriber.mockResolvedValueOnce({ email: "alice@example.com", unsubscribeToken: "tok123" });
    await notifySubmitterOfReceipt(sub());
    const { html } = mockSend.mock.calls[0]![0];
    expect(html).toContain('<a href="https://whererat.com/unsubscribed?token=tok123"');
    expect(html).not.toContain("&lt;span");
  });

  it("BUG: a failing subscriber lookup makes notifySubmitterOfReceipt reject (module promises 'never throw'; caller uses `void` => unhandled rejection)", async () => {
    mockSubscriber.mockRejectedValueOnce(new Error("db down"));
    await expect(notifySubmitterOfReceipt(sub())).resolves.toBeUndefined();
  });

  it("BUG: a failing subscriber lookup makes notifySubmitterOfDecision reject instead of being best-effort", async () => {
    mockSubscriber.mockRejectedValueOnce(new Error("db down"));
    await expect(notifySubmitterOfDecision(sub(), "approved")).resolves.toBeUndefined();
  });
});
