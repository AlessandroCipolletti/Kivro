import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { SellerCapability } from "../src/lib/types";
import { CapabilityHealth } from "../src/components/capability-health";
import { recommendationCapability } from "./support/recommendations";

it("keeps configured concurrency, effective capacity and shared admission load separate with version-bound success provenance", () => {
  const cap: SellerCapability = { ...recommendationCapability(), concurrency: 4, maxQueue: 10, maxScheduled: 20, liveState: { observedAt: "2026-10-06T10:00:00Z", runningJobs: 1, queueDepth: 3, scheduledJobs: 2, effectiveConcurrency: 2, capacityLoad: 4, lastSuccess: { jobId: crypto.randomUUID(), capabilityVersionId: crypto.randomUUID(), completedAt: "2026-10-06T09:00:00Z" } } };
  const html = renderToStaticMarkup(React.createElement(CapabilityHealth, { capability: cap }));
  for (const text of ["Running jobs</dt><dd>1", "Configured concurrency</dt><dd>4", "Effective concurrency</dt><dd>2", "Queued / configured limit</dt><dd>3 / 10", "Admission capacity load</dt><dd>4", "counts span all versions", "success used a different version"]) expect(html).toContain(text);
  expect(html).toContain(`/jobs/${cap.liveState!.lastSuccess!.jobId}`); expect(html).toContain(cap.liveState!.lastSuccess!.capabilityVersionId);
  expect(html).toContain("does not establish current validation or readiness");
});
it("does not turn missing snapshots or last success into invented zero, and preserves measured zero capacity", () => {
  const cap: SellerCapability = recommendationCapability();
  expect(renderToStaticMarkup(React.createElement(CapabilityHealth, { capability: cap }))).toContain("Missing values are not zero");
  cap.liveState = { observedAt: "2026-10-06T10:00:00Z", runningJobs: 0, queueDepth: 0, scheduledJobs: 0, effectiveConcurrency: 0, capacityLoad: 0, lastSuccess: null };
  const html = renderToStaticMarkup(React.createElement(CapabilityHealth, { capability: cap }));
  expect(html).toContain("Effective concurrency</dt><dd>0"); expect(html).toContain("Configured concurrency</dt><dd>Not reported"); expect(html).toContain("No recorded successful job");
  expect(html).not.toContain("Validation passed");
});
