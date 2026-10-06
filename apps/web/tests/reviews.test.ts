import { describe, expect, it } from "vitest";
import { reviewNeedsReload, reviewReason } from "../src/lib/reviews";

describe("verified review policy", () => {
  it.each(["REVIEW_CONFLICT", "REVIEW_ALREADY_EXISTS", "REVIEW_EDIT_WINDOW_CLOSED", "REVIEW_NOT_ELIGIBLE", "REVIEW_NOT_FOUND"])("requires a fresh owner status after %s", code => expect(reviewNeedsReload(code)).toBe(true));
  it("does not fabricate eligibility for unknown reasons or transient errors", () => {
    expect(reviewNeedsReload("NETWORK_ERROR")).toBe(false);
    expect(reviewReason(null)).toContain("determined by");
    expect(reviewReason("JOB_NOT_PAID")).toContain("settled paid job");
    expect(reviewReason("SELF_REVIEW")).toContain("cannot review your own");
  });
});
