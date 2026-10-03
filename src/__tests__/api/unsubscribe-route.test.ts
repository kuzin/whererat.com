import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/email-preferences-store", () => ({ unsubscribeByToken: vi.fn() }));

import { GET } from "@/app/api/unsubscribe/route";
import { unsubscribeByToken } from "@/lib/email-preferences-store";

const mockUnsub = vi.mocked(unsubscribeByToken);

function call(search: string) {
  return GET(new NextRequest(`http://localhost:3000/api/unsubscribe${search}`));
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/unsubscribe", () => {
  it("redirects to invalid when the token is missing, without touching the DB", async () => {
    const res = await call("");
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname + loc.search).toBe("/unsubscribed?status=invalid");
    expect(mockUnsub).not.toHaveBeenCalled();
  });

  it("treats an empty / whitespace-only token as missing", async () => {
    for (const q of ["?token=", "?token=%20%20%20"]) {
      const res = await call(q);
      expect(res.headers.get("location")).toContain("status=invalid");
    }
    expect(mockUnsub).not.toHaveBeenCalled();
  });

  it("redirects to ok when the token matches", async () => {
    mockUnsub.mockResolvedValue(true);
    const res = await call("?token=abc123");
    expect(res.headers.get("location")).toBe("http://localhost:3000/unsubscribed?status=ok");
    expect(mockUnsub).toHaveBeenCalledWith("abc123");
  });

  it("redirects to invalid for an unknown or already-used token", async () => {
    mockUnsub.mockResolvedValue(false);
    const res = await call("?token=nope");
    expect(res.headers.get("location")).toContain("status=invalid");
  });

  it("trims the token before lookup", async () => {
    mockUnsub.mockResolvedValue(true);
    await call("?token=%20abc%20");
    expect(mockUnsub).toHaveBeenCalledWith("abc");
  });

  it("uses the first token when repeated and never echoes it in the redirect URL", async () => {
    mockUnsub.mockResolvedValue(true);
    const res = await call("?token=first&token=second");
    expect(mockUnsub).toHaveBeenCalledWith("first");
    expect(res.headers.get("location")).not.toContain("first");
  });

  it("passes hostile token values to the store verbatim (parameterised there) and redirects in-site", async () => {
    mockUnsub.mockResolvedValue(false);
    const res = await call(`?token=${encodeURIComponent("' OR 1=1 --")}`);
    expect(mockUnsub).toHaveBeenCalledWith("' OR 1=1 --");
    expect(new URL(res.headers.get("location")!).origin).toBe("http://localhost:3000");
  });

  it("the redirect target is always the same origin as the request (no open redirect via query)", async () => {
    mockUnsub.mockResolvedValue(true);
    const res = await call("?token=t&next=https://evil.example/");
    expect(new URL(res.headers.get("location")!).origin).toBe("http://localhost:3000");
  });

  it("surfaces a DB failure instead of claiming success", async () => {
    mockUnsub.mockRejectedValue(new Error("db down"));
    await expect(call("?token=abc")).rejects.toThrow("db down");
  });
});
