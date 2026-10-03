import Image from "next/image";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import {
  MODERATOR_SESSION_COOKIE,
} from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { getStoredModeratorById } from "@/lib/user-store";
import { updatePassword, updateProfile } from "./actions";
import { AvatarUploadField } from "@/components/forms/avatar-upload-field";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: "Profile",
  description: "Manage moderator profile details, avatar, and password.",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ProfilePage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const cookieStore = await cookies();
  const session = await verifyModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );

  if (!session) {
    redirect("/login?next=/profile");
  }

  const account = await getStoredModeratorById(session.id);
  await searchParams;

  if (!account) {
    redirect("/login?next=/profile");
  }

  return (
    <main className="wr-page-shell py-10">
      <section className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <aside className="self-start rounded-2xl wr-panel-warm p-8">
          <Image
            src={account.avatarUrl}
            alt={`${account.name} profile picture`}
            width={160}
            height={160}
            className="h-28 w-28 rounded-2xl border-2 border-stone-950/90 object-cover shadow-[2px_2px_0_0_var(--wr-shadow-btn-soft)] dark:border-white/22 dark:shadow-[2px_2px_0_0_rgb(0_0_0/0.45)]"
          />
          <h1 className="wr-display mt-6 text-4xl font-bold tracking-tight">
            {account.name}
          </h1>
          <p className="mt-2 text-stone-800 dark:text-amber-100/90">
            @{account.username} · {account.role}
          </p>
          <p className="mt-1 text-stone-800 dark:text-amber-100/90">{account.email}</p>

        </aside>

        <div className="space-y-6">
          <section className="wr-card p-6 sm:p-7">
            <h2 className="wr-display text-3xl font-black tracking-tight">Profile settings</h2>
            <form action={updateProfile} className="mt-6 grid gap-4">
              <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                Display name
                <input
                  name="name"
                  required
                  defaultValue={account.name}
                  className="wr-input"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                Username
                <input
                  value={`@${account.username}`}
                  disabled
                  readOnly
                  className="wr-input opacity-80"
                />
                <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
                  Usernames are managed by admins. Contact an admin if you need to change yours.
                </span>
              </label>
              <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                Email
                <input
                  name="email"
                  type="email"
                  required
                  defaultValue={account.email}
                  className="wr-input"
                />
              </label>
              <div className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                Role
                <p className="wr-input flex items-center font-medium capitalize" data-testid="profile-role">
                  {account.role}
                </p>
                <p className="text-xs font-medium text-stone-500 dark:text-stone-400">
                  Roles are managed by an owner on the Users page.
                </p>
              </div>
              <AvatarUploadField initialAvatarUrl={account.avatarUrl} displayName={account.name} />
              <button type="submit" className="wr-btn-primary">
                Save profile changes
              </button>
            </form>
          </section>

          <section className="wr-card p-6 sm:p-7">
            <h2 className="wr-display text-3xl font-black tracking-tight">Update password</h2>
            <form action={updatePassword} className="mt-6 grid gap-4">
              <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                Current password
                <input
                  name="currentPassword"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="wr-input"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                New password
                <input
                  name="nextPassword"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="wr-input"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-bold text-stone-700 dark:text-stone-200">
                Confirm new password
                <input
                  name="confirmPassword"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="wr-input"
                />
              </label>
              <button type="submit" className="wr-btn-primary">
                Update passphrase
              </button>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}
