# Data Handling and Retention

This describes the implemented private-beta system. It is not a production
privacy notice, legal opinion or certification. Production requires operator
terms and version, a configured malware scanner and review of actual providers,
contracts, backups, infrastructure logs and applicable retention obligations.

## Processing Boundaries

- The platform stores buyer uploads temporarily in private object storage.
  Uploads go to a quarantined presigned key; ownership, hash, size, MIME and scan
  checks precede an immutable published copy. Production fails closed without
  a configured scanner. Development-only scan status is not malware clearance.
- A seller-controlled Worker receives buyer input only after signed acceptance
  of a current paid attempt. Execution uses the approved isolated runtime and
  declared dependencies. Isolation is not a claim that the platform controls
  the seller's physical machine or can prevent an authorized seller copying data.
- The declared seller inference provider receives approved job context. Resource
  and research access obey the manifest and separate brokers. A seller credential
  is not the platform's OpenAI/Anthropic credential and is never silently imported.
- Platform discovery/planning and explicitly consented synthesis use the selected
  platform provider. No automatic cross-provider fallback is enabled. Synthesis
  retains source provenance and does not automatically upload result file bytes.
- Download links expire, but a previously downloaded copy cannot be recalled.
  Presigned-download audit counts bytes authorized, not actual network transfer.

## Current Retention

| Data | Policy |
|---|---|
| Private input and output assets | `ASSET_RETENTION_DAYS`, default 7 days from asset creation; exact expiry is returned with the asset. Maintenance deletes expired objects and marks their records deleted. |
| Terminal job input/output payloads | `JOB_CONTENT_RETENTION_DAYS`, default 30 days after completion. The value is frozen when the job is created; the job page receives its exact deadline. Maintenance clears payloads without rewriting ownership, contract, prices or ledger. |
| Worker-health transitions and download grants | `OPERATIONAL_AUDIT_RETENTION_DAYS`, default 90 days. Only these operational audit types are purged by this policy. |
| Upload quarantine | Intent expires after 10 minutes; presigned PUT expires after 5 minutes. Maintenance removes expired staging objects. |
| Reset/verification mail | Token expires after 30 minutes. Encrypted body is cleared after delivery, exhaustion, consumption or expiry; operational rows have bounded cleanup. |
| Seller-owned approved examples | Explicitly approved independent copies, not ordinary job assets. They remain available only while published and authorized, until revoked/deleted. |
| Ledger, billing, job status and security audit | Not automatically erased by job-content expiry. Preserve financial reconciliation and incident evidence; determine the production retention policy separately. |
| Agent conversations/plans and problem reports | Separate records, not covered by job-content deletion. They can include copied user text and provenance. Do not promise whole-account erasure from the job-expiry feature. |

Maintenance is asynchronous: expiry immediately denies new private-asset access;
physical deletion follows the next successful maintenance pass. Monitor failures.
Backups and external-provider copies are not erased by an application-row update.

Worker temporary input/config/output directories are removed after execution,
including failure. A durable result outbox may retain the result payload until
the cloud acknowledges or rejects that attempt; acknowledging deletes the row.
Local sanitized attempt/audit history is distinct from temporary buyer files.
Do not copy production payloads into fixtures, logs, support tickets or examples.

## Access and Incidents

Reports are visible only to the reporter and authorized administrators. Report
resolution is not an automatic refund or payout action. Review outputs, affected
jobs and financial records separately. Follow `INCIDENT_RESPONSE.md` for
containment, evidence collection, credential rotation and recovery.
