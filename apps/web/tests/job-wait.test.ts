import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { JobWait } from "../src/components/job-wait";
import type { JobDTO } from "../src/lib/types";

it("shows eligible offline waiting and the authoritative deadline without implying failure or a release", () => {
  const job = { state: "SCHEDULED", scheduledAt: "2026-10-06T20:00:00Z", waitDeadline: "2026-10-07T20:00:00Z", waitReason: "ELIGIBLE_BUT_WORKER_OFFLINE" } as JobDTO;
  const html = renderToStaticMarkup(React.createElement(JobWait, { job }));
  expect(html).toContain("provider is currently offline"); expect(html).toContain("Latest acceptable start:"); expect(html).toContain("Credits remain reserved"); expect(html).not.toContain("ELIGIBLE_BUT_WORKER_OFFLINE");
});
it("does not invent a missing reason or deadline and terminal jobs have no current waiting notice", () => {
  const render = (job: Partial<JobDTO>) => renderToStaticMarkup(React.createElement(JobWait, { job: job as JobDTO }));
  expect(render({ state: "QUEUED" })).toContain("waiting reason was not supplied");
  expect(render({ state: "QUEUED" })).toContain("waiting deadline was not supplied");
  expect(render({ state: "SUCCEEDED", waitReason: "ELIGIBLE_BUT_WORKER_OFFLINE" })).toBe("");
});
