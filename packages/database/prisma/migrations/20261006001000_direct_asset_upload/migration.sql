CREATE TABLE "AssetUpload" (
  "id" UUID NOT NULL PRIMARY KEY,
  "ownerId" UUID NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "workerId" UUID REFERENCES "WorkerDevice"("id") ON UPDATE CASCADE,
  "jobId" UUID REFERENCES "Job"("id") ON UPDATE CASCADE,
  "attemptId" UUID REFERENCES "JobAttempt"("id") ON UPDATE CASCADE,
  "assetId" UUID UNIQUE REFERENCES "Asset"("id") ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('INPUT', 'OUTPUT')),
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" BETWEEN 1 AND 104857600),
  "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "objectKey" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "leaseId" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "stagingDeletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetUpload_kind_binding" CHECK (
    ("kind" = 'INPUT' AND "workerId" IS NULL AND "jobId" IS NULL AND "attemptId" IS NULL)
    OR ("kind" = 'OUTPUT' AND "workerId" IS NOT NULL AND "jobId" IS NOT NULL AND "attemptId" IS NOT NULL)
  )
);
CREATE INDEX "AssetUpload_ownerId_expiresAt_idx" ON "AssetUpload"("ownerId", "expiresAt");
CREATE INDEX "AssetUpload_expiresAt_stagingDeletedAt_idx" ON "AssetUpload"("expiresAt", "stagingDeletedAt");
