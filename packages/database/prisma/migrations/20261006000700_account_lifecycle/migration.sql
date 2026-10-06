ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE TABLE "AuthAction" (
  "id" UUID NOT NULL PRIMARY KEY,
  "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('PASSWORD_RESET', 'EMAIL_VERIFY')),
  "tokenHash" TEXT NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  "issuedEmail" TEXT NOT NULL,
  "credentialFingerprint" TEXT NOT NULL CHECK ("credentialFingerprint" ~ '^[a-f0-9]{64}$'),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuthAction_userId_kind_createdAt_idx" ON "AuthAction"("userId", "kind", "createdAt");
CREATE INDEX "AuthAction_expiresAt_idx" ON "AuthAction"("expiresAt");
CREATE TABLE "AccountEmail" (
  "id" UUID NOT NULL PRIMARY KEY,
  "actionId" UUID NOT NULL UNIQUE REFERENCES "AuthAction"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "payloadEncrypted" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 5),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseId" UUID,
  "deliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AccountEmail_nextAttemptAt_idx" ON "AccountEmail"("nextAttemptAt");
