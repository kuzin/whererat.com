import { parseModeratorSession, type ModeratorSession } from "@/lib/auth";
import { getAccountForSession } from "@/lib/user-store";

/**
 * The signed cookie proves who logged in, but its role/name are frozen at login
 * for up to 30 days. This re-checks the account on every privileged request, so
 * deleting a moderator, or demoting an owner, takes effect immediately instead of
 * when the cookie expires. The live account's profile replaces the cookie's copy.
 *
 * Fails closed: if the account can't be read, there is no session.
 */
export async function verifyModeratorSession(
  cookieValue: string | undefined,
): Promise<ModeratorSession | undefined> {
  const session = parseModeratorSession(cookieValue);
  if (!session) return undefined;
  try {
    const account = await getAccountForSession(session.id);
    if (!account) return undefined;
    // Defence in depth: a session object must never carry credentials.
    const { password: _password, ...live } = account as typeof account & { password?: unknown };
    void _password;
    return live;
  } catch (error) {
    console.error("[moderator-session] could not verify account:", error);
    return undefined;
  }
}
