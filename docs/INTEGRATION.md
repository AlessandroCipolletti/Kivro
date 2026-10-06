# Implementation integration contract

The supplied `spec/MASTER-SPEC.md` defines product behavior. This document fixes
interfaces for parallel implementation. It does not reduce product scope.

## Workspace

pnpm workspace, TypeScript ESM, Node >=22. Next.js App Router in `apps/web` on
port 3000; Fastify in `apps/api` on port 4000; host-native CLI in `apps/worker`.
Packages export TypeScript source via `src/index.ts` and use `tsx` at development
time. All internal package names are `@kivro/<folder>`. Root uses Vitest.

Ownership: main agent owns root configuration, infrastructure, scripts,
`packages/contracts`, `packages/policy-engine`, final docs and integration tests.
API agent owns `apps/api`, `packages/database`, `packages/billing`,
`packages/storage`. Worker agent owns `apps/worker`, `packages/openclaw-adapter`,
`packages/job-protocol`, `packages/crypto`, `security`. Web agent owns `apps/web`.
Agent-service agent owns `packages/marketplace-agent`, `packages/research-broker`
and `packages/integrations`. Do not edit another owner's files; report needed changes.

## Shared model

All IDs are UUIDs; timestamps are ISO 8601 UTC. Money is integer USD cents.
`PRICE_TIERS` has `id,currency,buyerPriceMinor,platformFeeMinor,sellerNetMinor,enabled,sortOrder`.
`priceTierId` uses `USD_99`, `USD_299`, `USD_499`, etc.

InputField: `key,label,type,required,order,description?,constraints?,default?,group?,visibleWhen?`.
Types: SHORT_TEXT, LONG_TEXT, INTEGER, NUMBER, BOOLEAN, SELECT, MULTI_SELECT, URL,
JSON, FILE, FILES. Constraints use Master Spec section 194-197 names.
IOContract: `{schemaVersion:1,inputs:InputField[],output:{type:'TEXT'|'JSON'|'FILES'|'MIXED',description:string,jsonSchema?:object,files?:{allowedMimeTypes:string[],allowedExtensions:string[],maxFiles:number,maxTotalSizeBytes:number},required:boolean}}`.
PermissionManifest: `{schemaVersion:1,tools:string[],network:{mode:'NONE'|'RESEARCH'|'CONNECTORS',allowedDomains:string[]},resources:{id:string,type:string,access:'READ_ONLY'}[],inference:{provider:string,model:string,credentialRef?:string},limits:{timeoutSeconds:number,memoryMb:number,cpu:number,maxPids:number,maxInputBytes:number,maxOutputBytes:number,maxTokens:number}}`.
Dependency: `{id,name,type,required,approved,healthy,confidence:'DECLARED'|'DETECTED'|'INFERRED',details?}`.
Schedule: `{mode:'ALWAYS'|'WEEKLY'|'MANUAL',timezone:string,windows:{day:number,start:string,end:string}[],overrides:{date:string,available:boolean,start?:string,end?:string}[]}` where day is 0=Sunday; support overnight.

CapabilityDTO: `{id,slug,title,summary,description,category,tags:string[],seller:{id,name,bio?},visibility:'DRAFT'|'PRIVATE'|'UNLISTED'|'PUBLIC',version:number,versionId,priceTierId,ioContract,permissions,dependencies,availability:{status:string,canRunNow:boolean,nextAvailableAt:string|null,reason:string|null},schedule,estimatedDurationSeconds,successRate:number|null,completedJobs:number,rating:number|null,reviewCount:number,isFavorite?:boolean,examples:{id,title,input:object,output:string}[]}`.
JobDTO: `{id,capabilityId,capabilityVersionId,capabilityTitle,buyerId,sellerId,state,paymentState,input,output:{text?:string,json?:unknown,assets?:AssetDTO[]}|null,priceSnapshot,createdAt,updatedAt,scheduledAt,startedAt,completedAt,error,events:{id,type,message,createdAt}[]}`.
AssetDTO: `{id,filename,mimeType,sizeBytes,sha256,downloadUrl?}`.
Job states: CREATED, PAYMENT_RESERVED, SCHEDULED, QUEUED, OFFERED, ACCEPTED, RUNNING,
PAUSE_REQUESTED, PAUSED, RESUMING, UPLOADING_RESULTS, VALIDATING_RESULTS, SUCCEEDED,
FAILED, CANCELLED, TIMED_OUT. Payment: RESERVED, SETTLED, RELEASED, REFUNDED.

## API

Every endpoint is prefixed `/api`; `/health` and `/ready` are also available.
Success responses are direct objects/arrays, errors `{error:{code,message,details?}}`.
Cookie authentication (`kivro_session`, HttpOnly, sameSite=lax); credentialed requests.
Mutations require same-origin/approved WEB_ORIGIN; no permissive wildcard CORS.
Browser API requests go through Next rewrite `/api/:path*` to API.

- GET /api/auth/me -> `{user:{id,name,email,isAdmin}|null}`
- POST /api/auth/register `{email,name,password}`; POST /api/auth/login `{email,password}` -> `{user}`
- POST /api/auth/logout
- POST /api/auth/dev-login `{role:'buyer'|'seller'|'admin'}` -> `{user}` ONLY explicitly enabled development
- GET /api/config -> `{priceTiers,devMode,paymentMode,categories}`
- GET /api/capabilities?q=&category=&availability=&maxPrice=&favorites= -> CapabilityDTO[]
- GET /api/capabilities/:idOrSlug -> CapabilityDTO
- POST /api/capabilities/:id/favorite -> `{isFavorite}`
- GET /api/capabilities/:id/reviews -> array; POST `{jobId,rating,comment}`
- GET /api/jobs; GET /api/jobs/:id -> JobDTO
- POST /api/jobs `{capabilityId,input,executionMode:'NOW'|'SCHEDULED',scheduledAt?,quoteId?}` with Idempotency-Key
- POST /api/jobs/:id/cancel, /pause, /resume
- POST /api/capabilities/:id/quote `{executionMode}` -> `{id,priceSnapshot,earliestStartAt,estimatedDeliveryAt,expiresAt}`
- POST /api/assets/upload (multipart file) -> AssetDTO; GET /api/assets/:id/download
- GET /api/wallet -> `{availableMinor,reservedMinor,spentMinor,earnedMinor,ledger:[]}`
- POST /api/wallet/topup `{amountMinor}` with Idempotency-Key -> `{url?}` (fake explicit dev only)
- POST /api/billing/webhook (Stripe raw-body verified)
- GET /api/seller/capabilities; POST /api/seller/capabilities -> CapabilityDTO draft
- PUT /api/seller/capabilities/:id -> new draft version (immutable published)
- POST /api/seller/capabilities/:id/publish `{visibility}`; POST /pause; PUT /schedule
- GET /api/seller/jobs; GET /api/seller/earnings; GET /api/seller/audit
- GET /api/seller/workers; POST /api/seller/pairing-code -> `{code,expiresAt}`
- POST /api/seller/workers/:id/pause and /resume and /revoke
- GET /api/admin/overview; POST /api/admin/dispatch `{enabled}`; POST /api/admin/users/:id/suspend; POST /api/admin/jobs/:id/refund
- GET/POST/DELETE /api/api-keys (scoped hashed bearer keys)
- GET/POST/DELETE /api/webhooks (signed event deliveries)
- POST /api/agent/chat `{message,timingMode,budgetMinor,conversationId?}` -> `{conversationId,message,recommendations:CapabilityDTO[],plan?}`
- GET /api/agent/conversations; POST /api/agent/plans/:id/approve; GET /api/agent/plans/:id

## Worker transport

Worker-to-API is outbound HTTPS polling with device Ed25519 signatures.
POST /api/worker/pair `{code,publicKey,name,version}` -> `{workerId,serverPublicKey}`.
Other requests signed headers `x-worker-id`, `x-worker-timestamp` (epoch ms),
`x-worker-nonce` (UUID), `x-worker-signature` (base64).
Canonical signed payload: `${method}\n${pathname}\n${timestamp}\n${nonce}\n${sha256(rawBody)}`.
GET has empty rawBody. Server stores consumed nonces with TTL and checks 60s skew.
POST /api/worker/heartbeat `{version,openclawVersion,sandboxReady,paused,capabilities:string[],runningJobIds:string[],health:object}` -> `{commands:[]}`.
GET /api/worker/offers -> `{offers:SignedJobNotice[]}`. A notice is a signed
JobOffer projection WITHOUT `input`, `internalInstructions` or `assets`; it adds
`payloadHash = hashManifest(fullJobOffer)`. This prevents disclosing buyer content
before acceptance. Worker verifies the signed notice and local manifest, persists
the attempt, sends ACCEPTED, then fetches the signed payload from
GET /api/worker/jobs/:id/payload?attemptId=UUID. This endpoint requires the same
authenticated device, current accepted attempt and secured payment. It denies
cancelled/revoked/expired attempts. Worker verifies payload signature, notice hash,
device/attempt/version and manifest before downloading assets or executing.
JobNoticeSchema and SignedJobNoticeSchema are shared exports.
SignedJobOffer is `{payload:JobOffer,signature:string}` over canonical stable JSON.
JobOffer: `{protocolVersion:1,jobId,attemptId,workerId,capabilityVersionId,expiresAt,paymentSecured:true,nonce,manifestHash,input,ioContract,permissions,internalInstructions,assets:AssetDTO[]}`.
POST /api/worker/jobs/:id/events `{attemptId,type:'ACCEPTED'|'RUNNING'|'PAUSED'|'RESUMING'|'FAILED'|'CANCELLED'|'TIMED_OUT',message?,error?}`.
POST /api/worker/jobs/:id/result `{attemptId,output:{text?,json?,assets?}}`.
POST /api/worker/jobs/:id/assets (multipart) -> AssetDTO, signed body handled explicitly.
Commands: `{id,jobId?,type:'PAUSE_ALL'|'RESUME_ALL'|'PAUSE_JOB'|'RESUME_JOB'|'CANCEL_JOB'}`.
All job actions verify worker ownership and active attempt. No settlement on seller assertion alone.

### Canonical execution manifest

`executionManifestProjection` and `executionManifestHash` from contracts are the
only shared projection/hash functions. They cover `{ioContract, permissions,
internalInstructions, dependencies}`; dependencies are required, with no silent
fallback. JobOffer and JobNotice carry the same dependencies. Database seed,
publication, local consent, notice verification and payload verification must
all use this function. Skill content, runtime/configuration provenance and
resource revisions belong in dependency nodes with explicit `contentHash`,
`source`, `dependsOn` and `grants`; private resource paths and secrets stay local.
Changing any bound node requires a new immutable capability version and local
consent. The Worker also pins its approved sandbox image ID and imported skill
hashes; unavailable or mismatched runtime provenance blocks readiness.

## Shared exports (main agent)

contracts: PRICE_TIERS, CATEGORIES, schemas/types IOContract, InputField,
PermissionManifest, Dependency, Schedule, CapabilityDTO, JobDTO, AssetDTO,
JobOffer, all matching `*Schema` exports, `getPriceTier(id)`, `validateInput(contract,input)`,
`validateOutput(contract,output)`, `hashManifest(value)`, `stableStringify(value)`.
policy-engine: `evaluateAvailability({schedule,workerOnline,sandboxReady,paused,securityBlocked,runningJobs,concurrency,queueDepth,maxQueue},now?)`,
`nextScheduledTime(schedule,now)`, `isScheduleOpen(schedule,now)`, `validatePublicUrl(url)` async,
`assertSafeRelativePath(path)`, `assertProductionConfiguration(env)`, `canTransition(from,to)`, `assertTransition(from,to)`.

Agents may export additional local types. Raise required shared changes with main agent.
