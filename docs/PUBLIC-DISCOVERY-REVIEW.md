# Public Discovery Review

2026-10-06, parent implementation receipt, not an independent security review.
Master 155 and its complete surrounding discovery requirements were reread.

The earlier deterministic matcher considered only title, summary, category and
tags. A capability matching only a public description, input/output contract or
published example could therefore be excluded before model reranking. The model
context also omitted description and examples. This was an actual code gap,
not missing provider credentials.

`packages/marketplace-agent/src/public-discovery.ts` now builds a version-local,
explicitly whitelisted searchable representation of public descriptions,
contracts, semantic tags, file formats and examples. Deterministic query ranking
and factual matched-term explanations use that representation. Model context
receives description/example previews capped at 768 serialized bytes per record,
still labelled
untrusted marketplace data. Existing inference context/token/cost ceilings and
hard purchase constraints are unchanged; oversized overall context fails closed.
Ranking calculates relevance once per capability per request, not during every
sort comparison. Unicode words retain their accents.

The representation excludes internal instructions, seller profiles, dependency
configuration, resource identities, inference credentials, undeclared example
input keys, file-input IDs and asset download URLs. Public asset names/types are
metadata, not file-content access. Private/unlisted/draft versions are excluded.
The ephemeral representation follows current public DTOs, so revoked examples
do not survive in a separate stale index. No search cluster was added. This
cannot detect a secret intentionally published inside an otherwise public
description/example; publication review remains a distinct trust boundary.

Verification at 13:43:10 CEST: all **189 marketplace-agent tests** passed, including
18 new public-discovery cases and existing 18 recommendation cases. Scoped
TypeScript and ESLint passed. Tests cover isolated matches from each public
surface, accented terms, private-data exclusions, revocation, context bounds,
hard budget/seller/timing constraints and synthetic recommendation inference
with zero purchase/file-transfer authority. No real provider was contacted.

Master 208/233's actual buyer-file attachment and strong format-aware matching
are a separate confirmed gap now assigned to the contract-matching owner. Mere
keyword inclusion of `pdf` or `blender` is not structured compatibility, and this
receipt does not claim otherwise. API catalog paging still bounds agent scans
to the existing ten pages; this is not large-catalog retrieval-quality evidence.
