import type { Metadata } from "next";
import Link from "next/link";
import { verifyOptInToken } from "@/lib/opt-in-token";
import { confirmNewsSubscription } from "./actions";

export const metadata: Metadata = {
  title: "Confirm subscription — WhereRat",
  robots: "noindex",
};

type Props = {
  searchParams: Promise<{ token?: string; status?: string }>;
};

export default async function ConfirmSubscriptionPage({ searchParams }: Props) {
  const { token, status } = await searchParams;
  const email = status ? undefined : verifyOptInToken(token);

  const view =
    status === "ok"
      ? {
          emoji: "💌",
          title: "You're subscribed",
          body: "Thanks! We'll send you WhereRat updates. Every email has an unsubscribe link.",
        }
      : status === "error"
        ? {
            emoji: "🤔",
            title: "Something went wrong",
            body: "We couldn't save your subscription. Please try the link in your email again in a minute.",
          }
        : email
          ? {
              emoji: "🐀",
              title: "Send me WhereRat updates?",
              body: `Confirm to subscribe ${email} to occasional WhereRat news. You can unsubscribe any time.`,
            }
          : {
              emoji: "🤔",
              title: "Link not recognised",
              body: "This confirmation link is invalid or has expired (they last 7 days). You can opt in again the next time you submit a sighting.",
            };

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="max-w-md">
        <p className="mb-4 text-5xl">{view.emoji}</p>
        <h1 className="wr-display mb-3 text-2xl font-bold text-stone-900 dark:text-amber-50">
          {view.title}
        </h1>
        <p className="mb-8 text-stone-600 dark:text-stone-400">{view.body}</p>
        {email ? (
          <form action={confirmNewsSubscription} className="mb-6">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="wr-btn-primary">
              Yes, subscribe me
            </button>
          </form>
        ) : null}
        <Link
          href="/"
          className="text-sm font-semibold text-amber-700 underline-offset-4 hover:underline dark:text-amber-400"
        >
          Back to WhereRat
        </Link>
      </div>
    </main>
  );
}
