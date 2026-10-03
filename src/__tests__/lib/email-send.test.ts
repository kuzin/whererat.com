import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendBrandedEmail } from "@/lib/email-send";

const ENV = ["RESEND_API_KEY", "MODERATION_NOTIFY_FROM"] as const;
const saved: Record<string, string | undefined> = {};
let fetchMock: ReturnType<typeof vi.fn>;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

const base = { to: "a@example.com", subject: "Hi", html: "<p>hi</p>", text: "hi" };

function body() {
  return JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RESEND_API_KEY = "re_test_key";
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  info.mockRestore();
  warn.mockRestore();
});

describe("sendBrandedEmail", () => {
  it("skips (no network, no throw) when RESEND_API_KEY is unset, and logs the tag", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendBrandedEmail({ ...base, logTag: "my-tag" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(info.mock.calls[0]![0]).toContain("[my-tag]");
  });

  it("treats an empty-string key as unset", async () => {
    process.env.RESEND_API_KEY = "";
    await sendBrandedEmail(base);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs JSON to Resend with a bearer key", async () => {
    await sendBrandedEmail(base);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    expect(body()).toEqual({
      from: "WhereRat <no-reply@whererat.com>",
      to: "a@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });
  });

  it("sends both html and text parts", async () => {
    await sendBrandedEmail(base);
    expect(body().html).toBeTruthy();
    expect(body().text).toBeTruthy();
  });

  it("From: explicit arg beats MODERATION_NOTIFY_FROM beats the default", async () => {
    process.env.MODERATION_NOTIFY_FROM = "Env <env@x.com>";
    await sendBrandedEmail({ ...base, from: "Arg <arg@x.com>" });
    expect(body().from).toBe("Arg <arg@x.com>");
    fetchMock.mockClear();
    await sendBrandedEmail(base);
    expect(body().from).toBe("Env <env@x.com>");
  });

  it("forwards extra headers only when non-empty", async () => {
    await sendBrandedEmail({ ...base, headers: { "List-Unsubscribe": "<https://x>" } });
    expect(body().headers).toEqual({ "List-Unsubscribe": "<https://x>" });
    fetchMock.mockClear();
    await sendBrandedEmail({ ...base, headers: {} });
    expect(body()).not.toHaveProperty("headers");
  });

  it("sends to exactly one recipient string (no address list)", async () => {
    await sendBrandedEmail(base);
    expect(typeof body().to).toBe("string");
  });

  it("logs but does not throw on a non-2xx response, including the status and recipient", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(sendBrandedEmail({ ...base, logTag: "t" })).resolves.toBeUndefined();
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("429");
    expect(msg).toContain("a@example.com");
    expect(msg).toContain("rate limited");
  });

  it("does not log the API key on failure", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await sendBrandedEmail(base);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("re_test_key");
  });

  it("survives an unreadable error body", async () => {
    const res = new Response("x", { status: 500 });
    vi.spyOn(res, "text").mockRejectedValue(new Error("stream broke"));
    fetchMock.mockResolvedValue(res);
    await expect(sendBrandedEmail(base)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("swallows network errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendBrandedEmail({ ...base, logTag: "net" })).resolves.toBeUndefined();
    expect(warn.mock.calls[0]![0]).toContain("[net]");
  });

  it("defaults the log tag", async () => {
    delete process.env.RESEND_API_KEY;
    await sendBrandedEmail(base);
    expect(info.mock.calls[0]![0]).toContain("[email-send]");
  });
});
