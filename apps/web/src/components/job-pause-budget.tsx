"use client";
import { useEffect, useState } from "react";
import type { JobDTO } from "../lib/types";
import { pauseBudgetText } from "../lib/job-pause";

export function usePauseBudgetText(job: JobDTO) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!job.pausedAt || job.completedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.pausedAt, job.completedAt]);
  return pauseBudgetText(job, now);
}

export function JobPauseBudget({ job }: { job: JobDTO }) {
  const text = usePauseBudgetText(job);
  return <p className="small muted" aria-label="Job pause budget">{text}</p>;
}
