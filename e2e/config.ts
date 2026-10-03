/**
 * Shared constants for the Playwright suite. Everything here is test-only: a
 * throwaway local database, fixed throwaway secrets and credentials.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3200);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://e2e@127.0.0.1:54330/whererat_e2e?sslmode=disable";

/** Must match what the app server is started with (see playwright.config.ts). */
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-secret";

// Specs sign tokens with the app's own code (src/lib/auth.ts), which reads the secret
// when it is first imported. Every spec imports this file first, so set it here.
process.env.SESSION_SECRET = E2E_SESSION_SECRET;

export const ADMIN = { username: "admin", password: "e2e-admin-password-1", name: "E2E Admin" };
export const MODERATOR = { username: "mod", password: "e2e-moderator-password-1", name: "E2E Moderator" };
/** Seeded with a legacy plaintext password to exercise the in-place upgrade on login. */
export const LEGACY = { username: "legacy", password: "e2e-legacy-password-1", name: "Legacy Account" };
