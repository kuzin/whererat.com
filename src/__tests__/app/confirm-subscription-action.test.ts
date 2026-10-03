import { describe, it, expect, vi, beforeEach } from "vitest";

class Redirect extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("@/lib/email-preferences-store", () => ({ upsertMarketingOptIn: vi.fn() }));

import { confirmNewsSubscription } from "@/app/confirm-subscription/actions";
import { upsertMarketingOptIn } from "@/lib/email-preferences-store";
import { createOptInToken } from "@/lib/opt-in-token";

const mockOptIn = vi.mocked(upsertMarketingOptIn);

async function run(token: string | undefined) {
  const fd = new FormData();
  if (token !== undefined) fd.set("token", token);
  try {
    await confirmNewsSubscription(fd);
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  return undefined;
}

beforeEach(() => {
  mockOptIn.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("confirmNewsSubscription", () => {
  it("a valid token subscribes exactly the address inside it", async () => {
    expect(await run(createOptInToken("Alice@X.io"))).toBe("/confirm-subscription?status=ok");
    expect(mockOptIn).toHaveBeenCalledExactlyOnceWith("alice@x.io");
  });

  it.each([undefined, "", "garbage", "a.b", createOptInToken("a@x.io").slice(0, -3) + "AAA"])(
    "an invalid/tampered token (%#) subscribes nobody",
    async (token) => {
      expect(await run(token)).toBe("/confirm-subscription?status=invalid");
      expect(mockOptIn).not.toHaveBeenCalled();
    },
  );

  it("an expired token subscribes nobody", async () => {
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    expect(await run(createOptInToken("a@x.io", eightDaysAgo))).toBe("/confirm-subscription?status=invalid");
    expect(mockOptIn).not.toHaveBeenCalled();
  });

  it("a storage failure shows an error instead of a false success", async () => {
    mockOptIn.mockRejectedValueOnce(new Error("db down"));
    expect(await run(createOptInToken("a@x.io"))).toBe("/confirm-subscription?status=error");
  });
});
