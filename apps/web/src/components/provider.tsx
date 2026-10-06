"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { useResource, useAction } from "@/lib/hooks";
import { post } from "@/lib/api";
import type { Config, Terms, User } from "@/lib/types";
import { Button, Dialog, ErrorNotice, Field, Notice } from "./ui";
import { PasswordResetRequest } from "./password-reset-request";

interface AppContext { user: User | null; authLoading: boolean; config?: Config; configError?: string; authError?: string; authenticate: () => void; refreshAuth: () => void; updateUser: (user: User | null) => void; refreshConfig: () => void; logout: () => Promise<void> }
const Context = createContext<AppContext | null>(null);
export function useApp() { const value = useContext(Context); if (!value) throw new Error("Missing app provider"); return value; }
export function Provider({ children }: { children: ReactNode }) {
  const auth = useResource<{ user: User | null }>("/auth/me");
  const config = useResource<Config>("/config");
  const [authOpen, setAuthOpen] = useState(false);
  const [register, setRegister] = useState(false);
  const [forgot, setForgot] = useState(false);
  const terms = useResource<Terms>(authOpen && register ? "/terms" : null);
  const [acceptedTermsVersion, setAcceptedTermsVersion] = useState<string>();
  const action = useAction();
  const [logoutError, setLogoutError] = useState<string>();
  async function logout() {
    try { await post("/auth/logout"); auth.setData({ user: null }); window.location.assign("/"); }
    catch (error) { setLogoutError(error instanceof Error ? error.message : "Could not sign out."); }
  }
  const finish = (result: { user: User }) => { auth.setData(result); setAuthOpen(false); window.dispatchEvent(new Event("kivro-session")); };
  return <Context.Provider value={{ user: auth.data?.user || null, authLoading: auth.loading, config: config.data, configError: config.error, authError: auth.error, authenticate: () => { action.setError(undefined); setForgot(false); setRegister(false); setAcceptedTermsVersion(undefined); setAuthOpen(true); }, refreshAuth: auth.refresh, updateUser: user => auth.setData({ user }), refreshConfig: config.refresh, logout }}>
    {children}
    {logoutError && <div className="toast"><ErrorNotice error={logoutError} /></div>}
    <Dialog open={authOpen} onClose={() => setAuthOpen(false)} title={forgot ? "Reset your password" : register ? "Create your Kivro account" : "Welcome to Kivro"}>
      {forgot ? <><PasswordResetRequest /><Button variant="ghost" onClick={() => { setForgot(false); action.setError(undefined); }}>Back to sign in</Button></> : <>
      <div className="segmented"><button onClick={() => setRegister(false)} aria-pressed={!register}>Sign in</button><button onClick={() => setRegister(true)} aria-pressed={register}>Create account</button></div>
      <form className="stack" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void action.run(async () => { if (register && (!terms.data || acceptedTermsVersion !== terms.data.version)) throw new Error("Read and accept the current terms to create your account."); const result = await post<{ user: User }>(register ? "/auth/register" : "/auth/login", { email: data.get("email"), password: data.get("password"), ...(register ? { name: data.get("name"), acceptedTermsVersion } : {}) }); finish(result); }); }}>
        {register && <Field label="Name"><input name="name" autoComplete="name" required maxLength={100} /></Field>}
        <Field label="Email"><input type="email" name="email" autoComplete="email" required /></Field>
        <Field label="Password"><input type="password" name="password" minLength={register ? 12 : undefined} maxLength={128} autoComplete={register ? "new-password" : "current-password"} required /></Field>
        {register && <><ErrorNotice error={terms.error} retry={terms.refresh} />{terms.data?.preliminary && <p className="small muted">Preliminary development terms; not production legally reviewed.</p>}<label className="checkbox-row align-start"><input type="checkbox" required checked={Boolean(terms.data && acceptedTermsVersion === terms.data.version)} disabled={!terms.data} onChange={event => setAcceptedTermsVersion(event.target.checked ? terms.data?.version : undefined)} /><span>I have read and accept the <Link className="text-link" href="/terms" target="_blank">Terms {terms.data?.version}</Link>.</span></label></>}<ErrorNotice error={action.error} /><Button variant="primary" type="submit" busy={action.pending} disabled={register && (!terms.data || acceptedTermsVersion !== terms.data.version)}>{register ? "Create account" : "Sign in"}</Button>
      </form>
      {!register && <Button variant="ghost" onClick={() => setForgot(true)}>Forgot password?</Button>}
      {config.data?.devMode === true && <section className="dev-login"><Notice tone="warning">Development environment</Notice><div className="row wrap">{(["buyer", "seller", "admin"] as const).map(role => <Button key={role} disabled={action.pending} onClick={() => void action.run(async () => finish(await post<{ user: User }>("/auth/dev-login", { role })))}>{role.charAt(0).toUpperCase() + role.slice(1)} login</Button>)}</div></section>}
      </>}
    </Dialog>
  </Context.Provider>;
}
export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, authLoading, authenticate, authError, refreshAuth } = useApp();
  if (authLoading) return <div className="auth-state" role="status">Checking your account...</div>;
  if (authError) return <ErrorNotice error={authError} retry={refreshAuth} />;
  if (!user) return <div className="auth-state"><h2>Sign in to continue</h2><p>Your jobs, saved capabilities and account are in one place.</p><Button variant="primary" onClick={authenticate}>Sign in</Button></div>;
  if (admin && !user.isAdmin) return <Notice tone="danger">This page is restricted to platform administrators.</Notice>;
  return children;
}
