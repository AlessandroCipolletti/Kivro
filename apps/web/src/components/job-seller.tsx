import React from "react";
import Link from "next/link";
import type { JobDTO } from "../lib/types";

export function JobSeller({ job }: { job: Pick<JobDTO, "sellerId" | "sellerName"> }) {
  return <span className="job-seller"><Link href={`/sellers/${job.sellerId}`} title={`Seller ID: ${job.sellerId}`}>{job.sellerName ?? `Seller ${job.sellerId}`}</Link>{!job.sellerName && <span className="muted">Name at purchase not recorded</span>}</span>;
}
