"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  canAutoApproveSubmissions,
  MODERATOR_SESSION_COOKIE,
} from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";
import { executePublicSightingSubmit } from "@/lib/public-sighting-submit";
import { reviewSubmission } from "@/lib/moderation-store";

export async function submitSighting(formData: FormData) {
  const headerStore = await headers();
  const forwarded = headerStore.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "unknown";

  const cookieStore = await cookies();
  const moderatorSession = await verifyModeratorSession(
    cookieStore.get(MODERATOR_SESSION_COOKIE)?.value,
  );
  const wantsAutoApprove = formData.get("autoApprove") === "on";
  const shouldAutoApprove =
    wantsAutoApprove && canAutoApproveSubmissions(moderatorSession);

  const result = await executePublicSightingSubmit(formData, ip, {
    skipModerationNotify: shouldAutoApprove,
  });

  if (!result.ok) {
    if (result.code === "rate-limited") redirect("/submit?status=rate-limited");
    if (result.code === "no-imdb") redirect("/submit?status=no-imdb");
    redirect("/submit?status=missing");
  }

  const duplicateHint =
    typeof result.catalogMatchSlug === "string"
      ? `&match=${result.catalogMatchSlug}`
      : "";

  if (shouldAutoApprove && moderatorSession) {
    await reviewSubmission({
      submissionId: result.submissionId,
      decision: "approved",
      moderator: moderatorSession,
    });
    redirect(`/submit?status=approved${duplicateHint}`);
  }

  redirect(`/submit?status=queued${duplicateHint}`);
}
