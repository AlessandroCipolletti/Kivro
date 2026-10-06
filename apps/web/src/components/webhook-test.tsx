"use client";
import { useState } from "react";
import { Send } from "lucide-react";
import { post } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import type { Webhook } from "@/lib/types";
import { Button, Confirm, Notice } from "./ui";

export function WebhookTest({ webhook, refresh }: { webhook: Webhook; refresh: () => void }) {
  const [open, setOpen] = useState(false), [message, setMessage] = useState<string>();
  const action = useAction();
  return <><Button disabled={!webhook.enabled} onClick={() => { action.setError(undefined); setOpen(true); }}><Send size={14} />Send test event</Button>{message && <Notice>{message}</Notice>}<Confirm open={open} onClose={() => { if (!action.pending) setOpen(false); }} title="Send a webhook test?" description={`Queue a signed synthetic test event for ${webhook.url}? This does not create or purchase a job.`} confirmText="Queue test event" pending={action.pending} error={action.error} onConfirm={() => void action.run(async () => { const result = await post<{ deliveryId: string; status: string }>(`/webhooks/${webhook.id}/test`, {}); setMessage(`Test delivery ${result.deliveryId.slice(0,8)} queued. Delivery is not yet confirmed.`); setOpen(false); refresh(); })} /></>;
}
