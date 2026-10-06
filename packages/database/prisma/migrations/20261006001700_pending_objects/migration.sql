CREATE TABLE "PendingObject" (
  "id" UUID NOT NULL,
  "objectKey" TEXT NOT NULL,
  "ownerId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "cleanupStartedAt" TIMESTAMP(3),
  "committedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "assetId" UUID,
  "exampleAssetId" UUID,
  CONSTRAINT "PendingObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PendingObject_target" CHECK (
    ("committedAt" IS NULL AND "assetId" IS NULL AND "exampleAssetId" IS NULL) OR
    ("committedAt" IS NOT NULL AND num_nonnulls("assetId", "exampleAssetId") = 1 AND "cleanupStartedAt" IS NULL AND "deletedAt" IS NULL)
  ),
  CONSTRAINT "PendingObject_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PendingObject_exampleAssetId_fkey" FOREIGN KEY ("exampleAssetId") REFERENCES "CapabilityExampleAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PendingObject_objectKey_key" ON "PendingObject"("objectKey");
CREATE UNIQUE INDEX "PendingObject_assetId_key" ON "PendingObject"("assetId");
CREATE UNIQUE INDEX "PendingObject_exampleAssetId_key" ON "PendingObject"("exampleAssetId");
CREATE INDEX "PendingObject_committedAt_deletedAt_expiresAt_idx" ON "PendingObject"("committedAt", "deletedAt", "expiresAt");
