"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, MailCheck } from "lucide-react";
import { post } from "@/lib/api";
import { actionToken, passwordConfirmationError } from "@/lib/account";
import { useAction } from "@/lib/hooks";
import { useApp } from "./provider";
import { PasswordResetRequest } from "./password-reset-request";
import { Button, ErrorNotice, Field, Loading, Notice, PageHeading } from "./ui";

export function AuthActionPage({ kind }: { kind: "reset" | "verify" }) {
  const { authenticate, refreshAuth } = useApp();
  const [token, setToken] = useState<string>();
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const captured = useRef(false);
  const linkRevision = useRef(0);
  const action = useAction();
  const { setError } = action;
  useEffect(() => {
    function captureLink() {
      linkRevision.current++;
      const value = actionToken(window.location.hash);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      setToken(value); setDone(false); setError(undefined); setReady(true);
    }
    if (!captured.current) { captured.current = true; captureLink(); }
    window.addEventListener("hashchange", captureLink);
    return () => window.removeEventListener("hashchange", captureLink);
  }, [setError]);
  const reset = kind === "reset";
  return <><Link className="back-link" href="/"><ArrowLeft size={15} />Marketplace</Link>
    <PageHeading eyebrow="Account security" title={reset ? "Reset your password" : "Verify your email"} />
    <div className="account-action">
      {!ready ? <Loading text="Reading secure link" rows={0} /> : done ? <div className="stack">
        <Notice tone="success">{reset ? "Your password has been reset. All sessions and API keys have been revoked. Sign in with your new password." : "Your email address has been verified."}</Notice>
        {reset ? <Button variant="primary" onClick={authenticate}>Sign in</Button> : <Link className="button primary" href="/settings">Account settings</Link>}
      </div> : !token ? <div className="stack"><Notice tone="warning">This link is missing a valid token. Request a new email and open its complete link.</Notice>{reset ? <PasswordResetRequest /> : <Link className="button secondary" href="/settings">Account settings</Link>}</div> : <form key={token} className="stack" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget;
        const submittedRevision = linkRevision.current;
        void action.run(async () => {
          if (reset) {
            const data = new FormData(form), newPassword = String(data.get("password") || "");
            const error = passwordConfirmationError(newPassword, String(data.get("confirmation") || ""));
            if (error) throw new Error(error);
            await post("/auth/password-reset/confirm", { token, newPassword });
          } else await post("/auth/email-verification/confirm", { token });
          refreshAuth();
          if (submittedRevision === linkRevision.current) { form.reset(); setToken(undefined); setDone(true); }
        });
      }}>
        {reset ? <><Field label="New password" hint="12-128 characters"><input type="password" name="password" autoComplete="new-password" minLength={12} maxLength={128} required /></Field><Field label="Confirm new password"><input type="password" name="confirmation" autoComplete="new-password" minLength={12} maxLength={128} required /></Field><Notice tone="warning">Resetting your password signs out every session and revokes all API keys.</Notice></> : <Notice>Confirm this email address for your Kivro account.</Notice>}
        <ErrorNotice error={action.error} />
        <Button type="submit" variant="primary" busy={action.pending}>{reset ? <KeyRound size={16} /> : <MailCheck size={16} />}{reset ? "Reset password" : "Verify email"}</Button>
        {action.error && (reset ? <Button variant="ghost" onClick={() => { setToken(undefined); action.setError(undefined); }}>Request a new link</Button> : <Link className="text-link" href="/settings">Request a new link</Link>)}
      </form>}
    </div>
  </>;
}
