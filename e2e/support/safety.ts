/**
 * The suite truncates every table. This guard makes it physically impossible to
 * point it at anything but a local throwaway database.
 */
export function assertSafeE2EDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("E2E_DATABASE_URL is not a valid URL.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!local || !/e2e/i.test(dbName)) {
    throw new Error(
      `Refusing to run e2e against "${host}/${dbName}": the database must be on localhost and its name must contain "e2e".`,
    );
  }
}
