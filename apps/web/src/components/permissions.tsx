import React from "react";
import { AppWindow, Database, FileLock2, FolderLock, Globe2, KeyRound, Monitor, Send, ShieldCheck, Terminal } from "lucide-react";
import type { PermissionManifest } from "../lib/types";
import { publicPermissions } from "../lib/public-permissions";
import { Notice } from "./ui";

const icons = { inference: ShieldCheck, internet: Globe2, browser: Monitor, database: Database, "private-api": KeyRound,
  "local-files": FileLock2, "local-directories": FolderLock, "local-software": AppWindow, shell: Terminal,
  "external-actions": Send, "buyer-files": FileLock2, "other-resources": ShieldCheck };

export function Permissions({ permissions: p }: { permissions: PermissionManifest }) {
  const summary = publicPermissions(p);
  return <section aria-label="Permission manifest"><dl className="permission-list">
    {summary.rows.map(row => { const Icon = icons[row.key as keyof typeof icons]; return <div key={row.key} data-permission={row.key} data-state={row.state}><Icon size={18} aria-hidden="true" /><dt>{row.label}</dt><dd>{row.value}</dd></div>; })}
  </dl>{summary.unsupported && <Notice tone="warning">This declaration includes permissions unsupported by the current worker. It cannot establish execution readiness.</Notice>}
    <p className="small muted">Declared access limits for this version, not proof of local approval or current readiness. Seller resources remain read-only; sandbox file creation does not authorize external actions.</p>
  </section>;
}
