import React from "react";
import type { JobDTO } from "../lib/types";
import { dateTime } from "../lib/format";
import { Notice } from "./ui";

const explanations = {
  WAITING_FOR_SCHEDULE: "Your job is waiting for its agreed availability window.",
  ELIGIBLE_BUT_WORKER_OFFLINE: "The provider is currently offline. Your job is eligible to start and will wait for the provider to reconnect, subject to the waiting limit.",
  PROVIDER_PAUSED: "The provider has paused new work. Your job is waiting, subject to the waiting limit.",
  PROVIDER_UNAVAILABLE: "The provider is currently unavailable. Your job will wait for readiness to recover, subject to the waiting limit.",
  WAITING_FOR_CAPACITY: "Your job is waiting for execution capacity.",
  WAITING_FOR_WORKER_ACCEPTANCE: "Your job is waiting for the provider to accept the offered work.",
  WAITING_FOR_WORKER_START: "The provider has accepted your job. Execution has not started yet.",
  DISPATCH_PAUSED: "New job dispatch is temporarily paused by the platform.",
  WAIT_LIMIT_REACHED: "The waiting limit has been reached. The platform is processing the job outcome and any reserved-credit release.",
} as const;

export function JobWait({ job }: { job: JobDTO }) {
  if (!["SCHEDULED", "QUEUED", "OFFERED", "ACCEPTED"].includes(job.state)) return null;
  const reason = job.waitReason ? explanations[job.waitReason] : undefined;
  return <Notice><strong>{job.waitReason === "ELIGIBLE_BUT_WORKER_OFFLINE" ? "Provider offline; your job is waiting" : "Waiting to start"}</strong>
    <p>{reason || (job.state === "SCHEDULED" ? "Your job is waiting for provider availability." : "Execution has not started. The current waiting reason was not supplied.")}</p>
    {job.state === "SCHEDULED" && job.scheduledAt && <p>Agreed eligibility: {dateTime(job.scheduledAt)}.</p>}
    <p>{job.waitDeadline ? `Latest acceptable start: ${dateTime(job.waitDeadline)}.` : "The waiting deadline was not supplied."} Credits remain reserved until the platform records execution or a release. You can cancel before execution starts.</p>
  </Notice>;
}
