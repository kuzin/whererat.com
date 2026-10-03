"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createModeratorSession,
  MODERATOR_SESSION_COOKIE,
} from "@/lib/auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { clientIpFromForwardedFor, isRateLimited } from "@/lib/rate-limit";
import { safeReturnTo } from "@/lib/submission-input";
import { authenticateStoredModerator } from "@/lib/user-store";

// Each attempt costs a real scrypt computation, and without a cap the owner
// password could be guessed freely. Per client IP, shared across instances.
const LOGIN_ATTEMPTS_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Same-site relative paths only: `//host` and `/\host` are treated as off-site by browsers.
function safeNextPath(value: FormDataEntryValue | null) {
  return safeReturnTo(typeof value === "string" ? value : undefined, "/moderation");
}

function withToast(path: string, toast: string) {
  const separator = path.includes("?") ? "&" : "?";

  return `${path}${separator}toast=${toast}`;
}

export async function loginModerator(formData: FormData) {
  const username = String(formData.get("username") ?? "").slice(0, 100);
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(formData.get("next"));

  const ip = clientIpFromForwardedFor((await headers()).get("x-forwarded-for"));
  if (await isRateLimited({ key: `login:${ip}`, max: LOGIN_ATTEMPTS_PER_WINDOW, windowMs: LOGIN_WINDOW_MS })) {
    redirect(`/login?error=too-many-attempts&next=${encodeURIComponent(next)}`);
  }

  const account =
    password.length > MAX_PASSWORD_LENGTH
      ? undefined
      : await authenticateStoredModerator(username, password);

  if (!account) {
    redirect(`/login?error=invalid&next=${encodeURIComponent(next)}`);
  }

  const cookieStore = await cookies();
  cookieStore.set(MODERATOR_SESSION_COOKIE, createModeratorSession(account), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });

  redirect(withToast(next, "logged-in"));
}

export async function logoutModerator() {
  const cookieStore = await cookies();
  cookieStore.delete(MODERATOR_SESSION_COOKIE);

  redirect("/login?toast=logged-out");
}
