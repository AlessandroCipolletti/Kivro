"use client";
import { useState } from "react";
import { Mail } from "lucide-react";
import { post } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { Button, ErrorNotice, Field, Notice } from "./ui";

export function PasswordResetRequest() {
  const action = useAction();
  const [message, setMessage] = useState<string>();
  return <form className="stack" onSubmit={event => {
    event.preventDefault(); const form = event.currentTarget;
    void action.run(async () => {
      const result = await post<{ ok: true; message: string }>("/auth/password-reset/request", { email: String(new FormData(form).get("email") || "").trim() });
      setMessage(result.message || "If that account exists, a password reset link will be sent.");
    });
  }}>
    <Field label="Account email"><input type="email" name="email" autoComplete="email" required maxLength={320} /></Field>
    {message && <Notice tone="success">{message}</Notice>}
    <ErrorNotice error={action.error} />
    <Button type="submit" variant="primary" busy={action.pending}><Mail size={16} />Send reset link</Button>
  </form>;
}
