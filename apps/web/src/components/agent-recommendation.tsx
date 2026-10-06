"use client";
import React from "react";
import { dateTime } from "../lib/format";
import { humanAvailability } from "../lib/availability";
import type { AgentRecommendation, CapabilityDTO } from "../lib/types";
import { Notice } from "./ui";

export function RecommendationRationale({ detail, capability }: { detail?: AgentRecommendation; capability?: CapabilityDTO }) {
  if (!detail || (capability && detail.capabilityId !== capability.id)) return <p className="recommendation-rationale small muted">No selection explanation was recorded for this result.</p>;
  const historical = !capability || detail.capabilityVersionId !== capability.versionId;
  return <section className="recommendation-rationale" aria-label={`Selection explanation for ${detail.capabilityTitle}`}>
    {historical && <Notice tone="warning">{capability ? "This explanation describes an earlier version, not the current listing." : "No current listing is loaded. These are saved recommendation facts."} Review current details before choosing this service.</Notice>}
    <h3>{historical ? "Recorded selection reason" : "Why selected"}</h3><p>{detail.reason}</p>
    {detail.preferred && <p className="small muted">Preferred for this request</p>}
    <dl className="recommendation-facts"><div><dt>Price</dt><dd>{detail.price.label}</dd></div><div><dt>Rating</dt><dd>{detail.rating.label}</dd></div><div><dt>Timing estimate</dt><dd>{humanAvailability({ status: detail.timing.status, canRunNow: detail.timing.canRunNow, canQueue: detail.timing.canQueue, nextAvailableAt: detail.timing.nextAvailableAt, reason: null }, detail.timing.estimatedQueueWaitSeconds)}; estimated runtime {detail.timing.estimatedRuntimeSeconds} seconds</dd></div><div><dt>Inputs & output</dt><dd>{detail.io.label}</dd></div><div><dt>Permissions</dt><dd>{detail.permissions.label}</dd></div></dl>
    {detail.tradeoffs.length > 0 && <><h3>Trade-offs</h3><ul>{detail.tradeoffs.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
    {detail.limitations.length > 0 && <><h3>Limitations</h3><ul>{detail.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
    <p className="small muted">Catalog facts recorded {dateTime(detail.generatedAt)}. Not an execution quote or reserved slot.</p><small className="mono">Version {detail.capabilityVersionId}</small>
  </section>;
}
