# Incident Response

Private-beta operator runbook. Assign an incident owner, record UTC times and
affected release/device/account/job IDs, and keep a restricted evidence log.
Never paste API keys, buyer inputs, raw model prompts or bank data into that log.
Use a separate approved evidence store when payload preservation is essential.

## Compromised Worker Release

1. Disable dispatch using the admin platform control. Add exact vulnerable
   versions to the security policy and, where required, raise minimum versions.
   A minimum-version change cannot make an unsupported runtime compatible.
2. Revoke affected devices or block affected capabilities/categories. Reconcile
   reserved jobs and check cancellation acknowledgments; do not assume that an
   offline machine received a remote command or that already-downloaded data
   can be recalled. Tell affected sellers through the operator's verified channel.
3. Preserve sanitized health, version, job, permission and financial evidence.
   Identify the first affected version and the actual scope of executed work.
4. Build and test the fixed artifact, publish its checksum/compatibility notes,
   require upgrade and fresh sandbox/capability proof. Rotate device credentials
   by revoking and explicitly re-pairing when exposure is plausible.
5. Re-enable dispatch only after acceptance tests and owner approval. Record
   which vulnerable versions remain permanently revoked.

## Seller Credential Leak

1. Pause the Worker locally and in seller controls; use revocation if compromised.
2. Revoke the affected provider/database credential at its issuer and replace the
   explicitly configured local secret. Pausing alone does not invalidate a key.
3. Review broker and provider audit by job/time, without exporting private data.
   Check resource grants and outbound destinations for unauthorized access.
4. Revalidate the dedicated provider, dependency closure and runtime. Publish a
   new capability version when its processor, permissions or dependencies change.
   No automatic reuse of personal OpenClaw/Codex credentials is permitted.

## Malicious Buyer

1. Suspend the account through the admin action; cancel affected reserved work.
   Recheck active Workers and financial state after maintenance completes.
2. Preserve relevant report, authorization, asset and job evidence in the
   restricted incident record; retain only what investigation requires.
3. Contact affected sellers through a verified operator channel. Review all
   related accounts/devices based on evidence, not merely a shared IP address.
4. Handle refunds/disputes with the existing idempotent provider/ledger services.
   Never edit or delete ledger rows to make balances look correct.

## Marketplace Compromise

1. Stop dispatch and isolate compromised API/Worker release infrastructure.
2. Rotate cloud database/storage/Stripe/webhook/signing credentials at their
   issuers. Invalidating sessions also requires revoking API keys when affected.
   A stolen Worker signing key requires a controlled trust-root migration or
   device re-pairing; do not silently replace trust on seller machines.
3. Assess device credential exposure separately. Seller local secrets are not
   centrally stored; do not assert exposure or safety without evidence.
4. Restore from reviewed backups in isolation, reconcile Stripe events and
   ledger history, verify active reservations and signed attempts, then execute
   the full security/runtime acceptance suite before reopening purchases.
5. The incident owner determines notifications with qualified privacy/legal
   review. This runbook supplies no statutory deadline or compliance guarantee.

## Financial Responsibility

Buyer credits are reserved before dispatch. Failed/cancelled pre-settlement work
releases its reservation; successful validated delivery settles once. An
approved post-settlement refund uses compensating ledger entries and transfer
reversal where required. Stripe disputes can create holds/suspensions and need
provider reconciliation; a favorable update is not assumed from a browser return.

Seller earnings, transfers to Connect and bank payouts are separate states.
Account-wide payout totals may include sources outside Kivro; arrival dates are
estimates and observed `paid` status is not a guaranteed irrevocable bank receipt.
The operator owns reconciliation and user communications, while seller output
quality and processing declarations remain subject to the applicable agreement.
Public-launch agreements, tax treatment and legal allocation require qualified
review before use; development terms are explicitly preliminary.

## Closure Evidence

Record affected scope, containment time, credential/release changes, test receipts,
financial reconciliation, unresolved exposure and notification decisions. Verify
no active vulnerable device/capability is dispatchable, outstanding reservations
have a justified state and the responsible owner approves reopening. Follow up
with a regression test and a documented retention decision for incident evidence.
