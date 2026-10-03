import { vi } from "vitest";

// Tests must never reach a real database through the shared rate limiter (a
// developer's shell may have DATABASE_URL set). `undefined` = "store unavailable",
// which makes callers use their in-memory fallback. rate-limit-store.test.ts
// opts back into the real module with vi.importActual.
vi.mock("@/lib/rate-limit-store", () => ({
  consumeSharedRateLimit: vi.fn(async () => undefined),
  resetRateLimitStoreWarning: vi.fn(),
}));
