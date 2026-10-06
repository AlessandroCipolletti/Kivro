"use client";
import { useState } from "react";
import { Pencil, RefreshCw, Star } from "lucide-react";
import type { JobReviewStatus, OwnReview, ReviewSummary } from "@/lib/types";
import { ApiError, post, put } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { reviewNeedsReload, reviewReason } from "@/lib/reviews";
import { Button, ErrorNotice, Field, Loading, Notice } from "./ui";

export function JobReview({ jobId }: { jobId: string }) {
  const resource = useResource<JobReviewStatus>(`/jobs/${encodeURIComponent(jobId)}/review`);
  const [message, setMessage] = useState<string>();
  return <section className="page-section" aria-label="Your verified review"><h2>Your review</h2>{message && <Notice tone="success">{message}</Notice>}<ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Checking your review eligibility" rows={0} /> : resource.data && <OwnReviewContent key={resource.data.review?.reviewHash || "unreviewed"} status={resource.data} reload={() => { setMessage(undefined); resource.refresh(); }} saved={edited => { setMessage(edited ? "Your verified review has been updated." : "Your verified review has been submitted."); resource.refresh(); }} />}</section>;
}

function OwnReviewContent({ status, reload, saved }: { status: JobReviewStatus; reload: () => void; saved: (edited: boolean) => void }) {
  const [editing, setEditing] = useState(!status.review && status.eligible);
  const [rating, setRating] = useState(status.review?.rating || 5);
  const [comment, setComment] = useState(status.review?.comment || "");
  const [needsReload, setNeedsReload] = useState(false);
  const action = useAction();
  return <div className="stack"><p className="small muted">Verified job / Purchased version {status.capabilityVersionNumber}</p>{status.review && !editing && <><div className="row between wrap"><span className="row"><Star size={17} />{status.review.rating}/5</span>{status.canEdit && <Button onClick={() => { setRating(status.review!.rating); setComment(status.review!.comment); setEditing(true); action.setError(undefined); }}><Pencil size={14} />Edit your review</Button>}</div><p className="prewrap">{status.review.comment || "No written comment."}</p><p className="small muted">Submitted {dateTime(status.review.createdAt)}</p></>}
    {status.policy.editDeadlineAt && <p className="small muted">Edits permitted until {dateTime(status.policy.editDeadlineAt)} ({status.policy.editWindowDays} days from the original submission).</p>}
    {!status.eligible && !status.canEdit && <p className="small muted">{reviewReason(status.reason)}</p>}
    {editing && <form className="stack" onSubmit={event => { event.preventDefault(); void action.run(async () => {
      try { if (status.review) await put<OwnReview>(`/jobs/${status.jobId}/review`, { rating, comment: comment.trim(), expectedReviewHash: status.review.reviewHash }); else await post<OwnReview>(`/capabilities/${status.capabilityId}/reviews`, { jobId: status.jobId, rating, comment: comment.trim() }); setEditing(false); saved(Boolean(status.review)); }
      catch (error) { if (error instanceof ApiError && reviewNeedsReload(error.code)) setNeedsReload(true); throw error; }
    }); }}><fieldset className="rating-input"><legend>Rating</legend>{[1,2,3,4,5].map(value => <label key={value} title={`${value} stars`}><input type="radio" name={`review-rating-${status.jobId}`} value={value} checked={rating === value} onChange={() => setRating(value)} disabled={action.pending} /><Star size={25} fill={value <= rating ? "currentColor" : "none"} /><span className="sr-only">{value} stars</span></label>)}</fieldset><Field label="Comment (optional)"><textarea maxLength={2000} rows={3} value={comment} onChange={event => setComment(event.target.value)} disabled={action.pending} /></Field><ErrorNotice error={action.error} />{needsReload && <Notice tone="warning">The stored review or edit policy changed. Your draft has not been applied. Reload the current review before submitting another change.</Notice>}<div className="row wrap"><Button type="submit" variant="primary" busy={action.pending} disabled={needsReload || (!status.eligible && !status.canEdit)}>{status.review ? "Save review changes" : "Submit verified review"}</Button>{needsReload ? <Button onClick={reload}><RefreshCw size={15} />Discard draft & reload review</Button> : status.review && <Button disabled={action.pending} onClick={() => setEditing(false)}>Cancel edit</Button>}</div></form>}
  </div>;
}

export function ReviewDistribution({ capabilityId }: { capabilityId: string }) {
  const resource = useResource<ReviewSummary>(`/capabilities/${encodeURIComponent(capabilityId)}/reviews/summary`);
  return <div className="review-distribution"><ErrorNotice error={resource.error} retry={resource.refresh} />{resource.loading ? <Loading text="Loading rating distribution" rows={0} /> : resource.data && <><div><strong>{resource.data.averageRating === null ? "Not rated" : `${resource.data.averageRating.toFixed(1)} / 5`}</strong><p className="small muted">{resource.data.reviewCount} verified reviews</p></div><div className="rating-bars">{[...resource.data.distribution].sort((a,b) => b.rating - a.rating).map(bin => <div key={bin.rating}><span>{bin.rating} stars</span><meter min={0} max={Math.max(1, resource.data!.reviewCount)} value={bin.count} aria-label={`${bin.rating} stars: ${bin.count} reviews`} /><span>{bin.count}</span></div>)}</div></>}</div>;
}
