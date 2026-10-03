/**
 * `WHERERAT_OFFLINE=1` turns off every outbound call to third-party data sources
 * (IMDb, OMDb, TMDB, remote poster fetches for palettes). The Playwright suite sets
 * it so tests are deterministic and never depend on, or load, anyone else's servers.
 */
export function isOffline(): boolean {
  return process.env.WHERERAT_OFFLINE === "1";
}
