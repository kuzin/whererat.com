import { describe, it, expect, vi, afterEach } from "vitest";
import { isOffline } from "@/lib/offline";

afterEach(() => vi.unstubAllEnvs());

describe("isOffline", () => {
  it("is on only for the exact value 1", () => {
    vi.stubEnv("WHERERAT_OFFLINE", "1");
    expect(isOffline()).toBe(true);
    for (const v of ["", "0", "true", "yes", " 1"]) {
      vi.stubEnv("WHERERAT_OFFLINE", v);
      expect(isOffline(), JSON.stringify(v)).toBe(false);
    }
  });

  it("is off by default", () => {
    vi.stubEnv("WHERERAT_OFFLINE", undefined as unknown as string);
    expect(isOffline()).toBe(false);
  });
});
