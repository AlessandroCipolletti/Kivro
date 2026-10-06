"use client";
import { useState } from "react";
import { KeyRound, MailCheck, Save, ShieldCheck } from "lucide-react";
import { post, put } from "@/lib/api";
import { passwordConfirmationError } from "@/lib/account";
import { useAction } from "@/lib/hooks";
import type { User } from "@/lib/types";
import { useApp } from "./provider";
import { Button, ErrorNotice, Field, Notice } from "./ui";
import { TermsAcceptance } from "./terms";

export function AccountSettings({ onPasswordChanged }: { onPasswordChanged: () => void }) {
  const { user, updateUser } = useApp();
  const [name, setName] = useState(user?.name || "");
  const [bio, setBio] = useState(user?.bio || "");
  const [saved, setSaved] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState<string>();
  const profile = useAction(), password = useAction(), verification = useAction();
  return <>
    <section className="settings-section"><div className="row"><ShieldCheck size={20} /><h2>Account</h2></div>
      <form className="stack" onSubmit={event => { event.preventDefault(); void profile.run(async () => {
        const result = await put<{ user: User }>("/account", { name: name.trim(), bio: bio.trim() || null });
        updateUser(result.user); setName(result.user.name); setBio(result.user.bio || ""); setSaved(true);
      }); }}>
        <div className="form-grid"><Field label="Name"><input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} autoComplete="name" required minLength={1} maxLength={100} /></Field><Field label="Email"><input type="email" value={user?.email || ""} readOnly /></Field></div>
        <Field label="Public seller bio"><textarea value={bio} onChange={event => { setBio(event.target.value); setSaved(false); }} maxLength={2000} rows={3} /></Field>
        {saved && <Notice tone="success">Profile saved.</Notice>}<ErrorNotice error={profile.error} />
        <div><Button type="submit" busy={profile.pending} disabled={!name.trim()}><Save size={15} />Save profile</Button></div>
      </form>
      <div className="account-verification row between wrap"><div className="row"><MailCheck size={17} /><span>{user?.emailVerifiedAt ? "Email verified" : "Email not verified"}</span></div>{!user?.emailVerifiedAt && <Button busy={verification.pending} onClick={() => void verification.run(async () => { const result = await post<{ ok: true; message?: string }>("/auth/email-verification/request", {}); setVerificationMessage(result.message || "A verification email has been requested."); })}>Send verification email</Button>}</div>
      {verificationMessage && <Notice tone="success">{verificationMessage}</Notice>}<ErrorNotice error={verification.error} />
    </section>
    <section className="settings-section"><h2>Terms</h2><TermsAcceptance /></section>
    <section className="settings-section"><div className="row"><KeyRound size={20} /><h2>Password</h2></div>
      <form className="stack" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; void password.run(async () => {
        const data = new FormData(form), newPassword = String(data.get("newPassword") || "");
        const error = passwordConfirmationError(newPassword, String(data.get("confirmation") || ""));
        if (error) throw new Error(error);
        await post("/account/password", { currentPassword: data.get("currentPassword"), newPassword });
        form.reset(); updateUser(null); onPasswordChanged(); window.dispatchEvent(new Event("kivro-session"));
      }); }}>
        <Field label="Current password"><input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></Field>
        <div className="form-grid"><Field label="New password" hint="12-128 characters"><input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></Field><Field label="Confirm new password"><input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></Field></div>
        <Notice tone="warning">Changing your password signs out every session and revokes all API keys.</Notice><ErrorNotice error={password.error} />
        <div><Button type="submit" busy={password.pending}><KeyRound size={15} />Change password</Button></div>
      </form>
    </section>
  </>;
}
