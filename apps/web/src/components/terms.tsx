"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FileCheck2 } from "lucide-react";
import { useAction, useResource } from "@/lib/hooks";
import { post } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { Terms, User } from "@/lib/types";
import { useApp } from "./provider";
import { Button, ErrorNotice, Loading, Notice, PageHeading } from "./ui";

export function TermsAcceptance({ onReady }: { onReady?: (ready: boolean) => void }) {
  const { user, updateUser } = useApp();
  const terms = useResource<Terms>(user ? "/terms" : null);
  const [acceptedVersion, setAcceptedVersion] = useState<string>();
  const action = useAction();
  const ready = Boolean(user && terms.data && user.termsAcceptedVersion === terms.data.version);
  useEffect(() => { onReady?.(ready); }, [ready, onReady]);
  if (!user) return null;
  return <section className="terms-acceptance stack" aria-label="Terms acceptance">
    <ErrorNotice error={terms.error} retry={terms.refresh} />{terms.loading && <Loading text="Checking current terms" rows={0} />}
    {terms.data && (user.termsAcceptedVersion === terms.data.version ? <p className="small muted"><FileCheck2 size={14} /> <Link className="text-link" href="/terms">Terms {terms.data.version}</Link> accepted {dateTime(user.termsAcceptedAt)}.</p> : <>
      {terms.data.preliminary && <Notice tone="warning">These are preliminary development terms, not production-approved legal terms.</Notice>}
      <label className="checkbox-row align-start"><input type="checkbox" checked={acceptedVersion === terms.data.version} onChange={event => setAcceptedVersion(event.target.checked ? terms.data?.version : undefined)} /><span>I have read and accept <Link href="/terms" target="_blank" className="text-link">Terms {terms.data.version}</Link>.</span></label>
      <ErrorNotice error={action.error} /><div><Button disabled={acceptedVersion !== terms.data.version} busy={action.pending} onClick={() => void action.run(async () => { const result = await post<{ user: User }>("/account/terms", { version: acceptedVersion }); updateUser(result.user); setAcceptedVersion(undefined); })}>Accept current terms</Button></div>
    </>)}
  </section>;
}

export function TermsPage() {
  const terms = useResource<Terms>("/terms");
  return <><PageHeading eyebrow="Kivro / Account" title="Terms" />{terms.loading && <Loading text="Loading current terms" />}<ErrorNotice error={terms.error} retry={terms.refresh} />{terms.data && <div className="legal-document stack">{terms.data.preliminary && <Notice tone="warning">Preliminary development terms. These have not received production legal review.</Notice>}<p className="small muted">Version {terms.data.version}</p><div className="prose prewrap">{terms.data.text}</div><details><summary>Document verification</summary><p className="mono small">SHA-256: {terms.data.sha256}</p></details><TermsAcceptance /></div>}</>;
}
