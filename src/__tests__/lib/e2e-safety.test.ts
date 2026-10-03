import { describe, it, expect } from "vitest";
import { assertSafeE2EDatabase } from "../../../e2e/support/safety";

// The e2e suite truncates every table. This guard is the only thing standing
// between it and a real database, so it gets its own tests.
describe("assertSafeE2EDatabase", () => {
  it.each([
    "postgresql://e2e@127.0.0.1:54330/whererat_e2e?sslmode=disable",
    "postgresql://e2e:e2e@localhost:5432/whererat_e2e",
    "postgres://x@[::1]:5432/my_e2e_db",
  ])("allows a local e2e database: %s", (url) => {
    expect(() => assertSafeE2EDatabase(url)).not.toThrow();
  });

  it.each([
    // remote hosts (e.g. the production Neon database)
    "postgresql://u:p@ep-odd-star-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
    "postgresql://u:p@db.example.com:5432/whererat_e2e",
    // local, but not an e2e-named database
    "postgresql://u@localhost:5432/whererat",
    "postgresql://u@127.0.0.1:5432/postgres",
    // look-alikes
    "postgresql://u@localhost.evil.example/whererat_e2e",
    "postgresql://u@127.0.0.1.evil.example/whererat_e2e",
    "postgresql://u@evil.example/localhost/whererat_e2e",
    "postgresql://localhost@evil.example/whererat_e2e",
  ])("refuses %s", (url) => {
    expect(() => assertSafeE2EDatabase(url)).toThrow(/Refusing to run e2e/);
  });

  it.each(["", "not a url", "localhost:5432/whererat_e2e"])("refuses an unparseable value %j", (url) => {
    expect(() => assertSafeE2EDatabase(url)).toThrow();
  });
});
