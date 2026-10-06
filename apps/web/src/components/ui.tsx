"use client";
import { AlertCircle, ArrowRight, CheckCircle2, Circle, Clock3, LoaderCircle, Pause, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import React, { Children, cloneElement, isValidElement, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { label } from "../lib/format";

export function Button({ children, variant = "secondary", busy, className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean }) {
  return <button {...props} type={type} disabled={props.disabled || busy} aria-busy={busy} className={`button ${variant} ${className}`}>{busy && <LoaderCircle className="spin" size={16} />}{children}</button>;
}
export function IconButton({ label: name, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} type={props.type || "button"} aria-label={name} title={name} className={`icon-button ${props.className || ""}`}>{children}</button>;
}
export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</header>;
}
export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "danger" | "success" | "warning" }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle;
  return <div className={`notice ${tone}`} role={tone === "danger" ? "alert" : "status"}><Icon size={18} /><div>{children}</div></div>;
}
export function ErrorNotice({ error, retry }: { error?: string; retry?: () => void }) {
  return error ? <Notice tone="danger"><div className="row wrap"><span>{error}</span>{retry && <Button variant="ghost" onClick={retry}><RefreshCw size={14} />Try again</Button>}</div></Notice> : null;
}
export function Loading({ text = "Loading", rows = 3 }: { text?: string; rows?: number }) {
  return <div className="loading-state" role="status"><span className="row"><LoaderCircle className="spin" size={17} />{text}</span><div className="skeletons" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <div className="skeleton" key={i} />)}</div></div>;
}
export function Empty({ title, description, href, action, icon }: { title: string; description?: string; href?: string; action?: string; icon?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-icon">{icon}</div>}<h2>{title}</h2>{description && <p>{description}</p>}{href && <Link className="button secondary" href={href}>{action}<ArrowRight size={16} /></Link>}</div>;
}
const statusNames: Record<string, string> = {
  ONLINE: "Available now", BUSY: "Busy", SCHEDULED_OFFLINE: "Available later", OFFLINE: "Provider offline", PAUSED: "Paused", SECURITY_BLOCKED: "Security block", NOT_READY: "Not ready", HEALTHY: "Healthy", DEGRADED: "Needs attention",
  CREATED: "Created", PAYMENT_RESERVED: "Payment reserved", SCHEDULED: "Scheduled", QUEUED: "Queued", OFFERED: "Connecting to provider", ACCEPTED: "Starting", RUNNING: "Running", PAUSE_REQUESTED: "Pause requested", RESUMING: "Resuming", UPLOADING_RESULTS: "Uploading results", VALIDATING_RESULTS: "Checking results", SUCCEEDED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", TIMED_OUT: "Timed out", SETTLED: "Paid", RESERVED: "Reserved", RELEASED: "Released", REFUNDED: "Refunded"
};
export function Status({ value, text }: { value: string; text?: string }) {
  const success = ["ONLINE", "HEALTHY", "SUCCEEDED", "COMPLETED", "SETTLED", "PUBLIC"].includes(value);
  const danger = ["FAILED", "TIMED_OUT", "SECURITY_BLOCKED", "SECURITY_WARNING", "NOT_READY"].includes(value);
  const pending = ["BUSY", "RUNNING", "ACCEPTED", "OFFERED", "RESUMING", "UPLOADING_RESULTS", "VALIDATING_RESULTS", "QUEUED"].includes(value);
  const paused = ["PAUSED", "PAUSE_REQUESTED"].includes(value);
  const Icon = success ? CheckCircle2 : danger ? AlertCircle : paused ? Pause : pending || value.includes("SCHEDULE") ? Clock3 : Circle;
  return <span className={`status ${success ? "positive" : danger ? "negative" : pending || paused ? "caution" : "neutral"}`}><Icon size={13} />{text || statusNames[value] || label(value)}</span>;
}
export function Dialog({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} className={wide ? "dialog wide" : "dialog"} onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="dialog-header"><h2 id={titleId}>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton></div><div className="dialog-body">{children}</div></dialog>;
}
export function Confirm({ open, title, description, onClose, onConfirm, pending, error, confirmText = "Confirm", danger = false }: { open: boolean; title: string; description: string; onClose: () => void; onConfirm: () => void; pending?: boolean; error?: string; confirmText?: string; danger?: boolean }) {
  return <Dialog open={open} title={title} onClose={() => { if (!pending) onClose(); }}><p>{description}</p><ErrorNotice error={error} /><div className="dialog-actions"><Button onClick={onClose} disabled={pending}>Keep as is</Button><Button variant={danger ? "danger" : "primary"} onClick={onConfirm} busy={pending}>{confirmText}</Button></div></Dialog>;
}
export function Metric({ label: name, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <div className="metric"><span>{name}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}
export function Field({ label: name, children, hint, error, required }: { label: string; children: ReactNode; hint?: string; error?: string; required?: boolean }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{name}{required && <span className="required" aria-hidden="true"> *</span>}</label>{Children.map(children, child => isValidElement(child) && ["input", "textarea", "select"].includes(String(child.type)) ? cloneElement(child as ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>, { id, "aria-describedby": hint || error ? `${id}-help` : undefined, "aria-invalid": Boolean(error) }) : child)}{(hint || error) && <div id={`${id}-help`}>{hint && <small>{hint}</small>}{error && <small className="field-error">{error}</small>}</div>}</div>;
}
