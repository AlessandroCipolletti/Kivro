export function reviewReason(reason: string | null): string {
  return ({ SELF_REVIEW: "You cannot review your own capability.", JOB_NOT_DELIVERED: "Reviews become available after successful delivery.", JOB_NOT_PAID: "A new review requires a successfully settled paid job.", REVIEW_EDIT_WINDOW_CLOSED: "The review editing window has closed.", ALREADY_REVIEWED: "A verified review has already been recorded for this job." } as Record<string, string>)[reason || ""] || "Review eligibility is determined by the job's delivery and payment state.";
}
export function reviewNeedsReload(code: string): boolean { return ["REVIEW_ALREADY_EXISTS", "REVIEW_CONFLICT", "REVIEW_EDIT_WINDOW_CLOSED", "REVIEW_NOT_ELIGIBLE", "REVIEW_NOT_FOUND"].includes(code); }
