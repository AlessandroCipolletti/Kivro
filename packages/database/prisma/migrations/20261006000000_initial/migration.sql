-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('CREATED', 'PAYMENT_RESERVED', 'SCHEDULED', 'QUEUED', 'OFFERED', 'ACCEPTED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'RESUMING', 'UPLOADING_RESULTS', 'VALIDATING_RESULTS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('DRAFT', 'PRIVATE', 'UNLISTED', 'PUBLIC');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" TIMESTAMP(3),
    "bio" TEXT,
    "stripeCustomerId" TEXT,
    "stripeConnectedAccountId" TEXT,
    "connectStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "userId" UUID NOT NULL,
    "availableMinor" INTEGER NOT NULL DEFAULT 0,
    "reservedMinor" INTEGER NOT NULL DEFAULT 0,
    "spentMinor" INTEGER NOT NULL DEFAULT 0,
    "earnedMinor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "operationKey" TEXT NOT NULL,
    "transactionId" UUID NOT NULL,
    "userId" UUID,
    "jobId" UUID,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amountMinor" INTEGER NOT NULL,
    "availableDelta" INTEGER NOT NULL DEFAULT 0,
    "reservedDelta" INTEGER NOT NULL DEFAULT 0,
    "spentDelta" INTEGER NOT NULL DEFAULT 0,
    "earnedDelta" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capability" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" UUID,
    "draftVersionId" UUID,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "securityBlocked" BOOLEAN NOT NULL DEFAULT false,
    "schedule" JSONB NOT NULL,
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "maxQueue" INTEGER NOT NULL DEFAULT 3,
    "maxScheduled" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityVersion" (
    "id" UUID NOT NULL,
    "capabilityId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "priceTierId" TEXT NOT NULL,
    "ioContract" JSONB NOT NULL,
    "permissions" JSONB NOT NULL,
    "dependencies" JSONB NOT NULL,
    "internalInstructions" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "estimatedDurationSeconds" INTEGER NOT NULL DEFAULT 60,
    "consentAt" TIMESTAMP(3),
    "testPassedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapabilityVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityGrant" (
    "capabilityId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "CapabilityGrant_pkey" PRIMARY KEY ("capabilityId","userId")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "userId" UUID NOT NULL,
    "capabilityId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("userId","capabilityId")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "capabilityId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerDevice" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "publicKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "openclawVersion" TEXT,
    "sandboxReady" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "localPaused" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "health" JSONB NOT NULL DEFAULT '{}',
    "runningJobIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerBinding" (
    "workerId" UUID NOT NULL,
    "capabilityVersionId" UUID NOT NULL,
    "healthy" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorkerBinding_pkey" PRIMARY KEY ("workerId","capabilityVersionId")
);

-- CreateTable
CREATE TABLE "PairingCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerNonce" (
    "workerId" UUID NOT NULL,
    "nonce" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerNonce_pkey" PRIMARY KEY ("workerId","nonce")
);

-- CreateTable
CREATE TABLE "WorkerCommand" (
    "id" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "jobId" UUID,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),

    CONSTRAINT "WorkerCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "capabilityId" UUID NOT NULL,
    "capabilityVersionId" UUID NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'CREATED',
    "paymentState" "PaymentState" NOT NULL DEFAULT 'RESERVED',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "priceSnapshot" JSONB NOT NULL,
    "buyerPriceMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "sellerNetMinor" INTEGER NOT NULL,
    "executionMode" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "waitDeadline" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "activeAttemptId" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAttempt" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OFFERED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nonce" UUID NOT NULL,
    "resultHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleQuote" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "capabilityId" UUID NOT NULL,
    "capabilityVersionId" UUID NOT NULL,
    "executionMode" TEXT NOT NULL,
    "priceSnapshot" JSONB NOT NULL,
    "earliestStartAt" TIMESTAMP(3) NOT NULL,
    "estimatedDeliveryAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "jobId" UUID,
    "attemptId" UUID,
    "kind" TEXT NOT NULL DEFAULT 'INPUT',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "scanStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetGrant" (
    "assetId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetGrant_pkey" PRIMARY KEY ("assetId","jobId")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "sellerId" UUID,
    "jobId" UUID,
    "workerId" UUID,
    "type" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topup" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "stripeSessionId" TEXT,
    "paymentIntentId" TEXT,
    "checkoutUrl" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Topup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerTransfer" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "stripeTransferId" TEXT,
    "reversalId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPlan" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "conversationId" UUID,
    "plan" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PROPOSED',
    "jobIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeConnectedAccountId_key" ON "User"("stripeConnectedAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_secretHash_key" ON "ApiKey"("secretHash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_operationKey_key" ON "LedgerEntry"("operationKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_createdAt_idx" ON "LedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_jobId_idx" ON "LedgerEntry"("jobId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_userId_endpoint_key_key" ON "IdempotencyRecord"("userId", "endpoint", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_slug_key" ON "Capability"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_currentVersionId_key" ON "Capability"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Capability_draftVersionId_key" ON "Capability"("draftVersionId");

-- CreateIndex
CREATE INDEX "Capability_sellerId_idx" ON "Capability"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityVersion_capabilityId_version_key" ON "CapabilityVersion"("capabilityId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Review_jobId_key" ON "Review"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDevice_publicKey_key" ON "WorkerDevice"("publicKey");

-- CreateIndex
CREATE INDEX "WorkerDevice_sellerId_idx" ON "WorkerDevice"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "PairingCode_codeHash_key" ON "PairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "WorkerNonce_expiresAt_idx" ON "WorkerNonce"("expiresAt");

-- CreateIndex
CREATE INDEX "WorkerCommand_workerId_ackedAt_idx" ON "WorkerCommand"("workerId", "ackedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_activeAttemptId_key" ON "Job"("activeAttemptId");

-- CreateIndex
CREATE INDEX "Job_buyerId_createdAt_idx" ON "Job"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_sellerId_createdAt_idx" ON "Job"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_state_scheduledAt_idx" ON "Job"("state", "scheduledAt");

-- CreateIndex
CREATE INDEX "Job_capabilityId_state_idx" ON "Job"("capabilityId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttempt_nonce_key" ON "JobAttempt"("nonce");

-- CreateIndex
CREATE INDEX "JobAttempt_workerId_state_idx" ON "JobAttempt"("workerId", "state");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_objectKey_key" ON "Asset"("objectKey");

-- CreateIndex
CREATE INDEX "Asset_ownerId_createdAt_idx" ON "Asset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_expiresAt_idx" ON "Asset"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_sellerId_createdAt_idx" ON "AuditEvent"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_jobId_idx" ON "AuditEvent"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Topup_stripeSessionId_key" ON "Topup"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Topup_paymentIntentId_key" ON "Topup"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "Topup_userId_idempotencyKey_key" ON "Topup"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SellerTransfer_jobId_key" ON "SellerTransfer"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerTransfer_stripeTransferId_key" ON "SellerTransfer"("stripeTransferId");

-- CreateIndex
CREATE INDEX "OutboxEvent_processedAt_createdAt_idx" ON "OutboxEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_deliveredAt_nextAttemptAt_idx" ON "WebhookDelivery"("deliveredAt", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

-- CreateIndex
CREATE INDEX "AgentConversation_userId_updatedAt_idx" ON "AgentConversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentPlan_userId_idx" ON "AgentPlan"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "CapabilityVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capability" ADD CONSTRAINT "Capability_draftVersionId_fkey" FOREIGN KEY ("draftVersionId") REFERENCES "CapabilityVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityVersion" ADD CONSTRAINT "CapabilityVersion_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDevice" ADD CONSTRAINT "WorkerDevice_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerBinding" ADD CONSTRAINT "WorkerBinding_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerBinding" ADD CONSTRAINT "WorkerBinding_capabilityVersionId_fkey" FOREIGN KEY ("capabilityVersionId") REFERENCES "CapabilityVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCommand" ADD CONSTRAINT "WorkerCommand_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_capabilityVersionId_fkey" FOREIGN KEY ("capabilityVersionId") REFERENCES "CapabilityVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_activeAttemptId_fkey" FOREIGN KEY ("activeAttemptId") REFERENCES "JobAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetGrant" ADD CONSTRAINT "AssetGrant_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetGrant" ADD CONSTRAINT "AssetGrant_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
