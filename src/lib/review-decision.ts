export type ReviewDecision = "approved" | "edited" | "edited and approved" | "rejected";

export const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  "approved",
  "edited",
  "edited and approved",
  "rejected",
];

/** Moderation form values are strings; only these four are real decisions. */
export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === "string" && (REVIEW_DECISIONS as readonly string[]).includes(value);
}
