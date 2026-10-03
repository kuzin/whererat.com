"use server";

import { redirect } from "next/navigation";
import { upsertMarketingOptIn } from "@/lib/email-preferences-store";
import { verifyOptInToken } from "@/lib/opt-in-token";

/** Runs when the person clicks the confirm button (a POST — mail scanners only GET). */
export async function confirmNewsSubscription(formData: FormData) {
  const email = verifyOptInToken(String(formData.get("token") ?? ""));
  if (!email) redirect("/confirm-subscription?status=invalid");

  try {
    await upsertMarketingOptIn(email);
  } catch (error) {
    console.error("[confirm-subscription] could not save opt-in:", error);
    redirect("/confirm-subscription?status=error");
  }
  redirect("/confirm-subscription?status=ok");
}
