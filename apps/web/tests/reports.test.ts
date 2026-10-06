import { describe, expect, it } from "vitest";
import { reportPayload, reportResolution } from "../src/lib/reports";
import type { ReportTarget } from "../src/lib/types";

describe("problem report contracts", () => {
  it("submits one target and trims the description", () => {
    expect(reportPayload({ jobId: "job" }, "DELIVERY", "  No output arrived for this job.  ")).toEqual({ jobId: "job", category: "DELIVERY", description: "No output arrived for this job." });
    expect(reportPayload({ capabilityId: "capability" }, "PRIVACY", "Privacy concern for this service.")).not.toHaveProperty("jobId");
  });
  it("rejects absent or ambiguous targets and invalid content", () => {
    expect(() => reportPayload({} as ReportTarget, "OTHER", "long enough text")).toThrow();
    expect(() => reportPayload({ jobId: "job", capabilityId: "cap" } as unknown as ReportTarget, "OTHER", "long enough text")).toThrow();
    expect(() => reportPayload({ jobId: "job" }, "OTHER", "  short   ")).toThrow();
    expect(() => reportPayload({ jobId: "job" }, "OTHER", "x".repeat(4001))).toThrow();
  });
  it("binds an operator's public response to the reviewed revision", () => {
    expect(reportResolution("IN_REVIEW", " Reviewing the reported issue. ", 3)).toEqual({ status: "IN_REVIEW", resolution: "Reviewing the reported issue.", expectedRevision: 3 });
    expect(() => reportResolution("RESOLVED", "too short", 3)).toThrow();
    expect(() => reportResolution("RESOLVED", "Resolution message", -1)).toThrow();
    expect(() => reportResolution("RESOLVED", "x".repeat(2001), 3)).toThrow();
  });
});
