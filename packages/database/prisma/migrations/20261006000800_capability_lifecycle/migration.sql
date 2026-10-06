ALTER TABLE "Capability" ADD COLUMN "lifecycleRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("lifecycleRevision" >= 0);
CREATE TABLE "CapabilityVersionLifecycle" (
  "versionId" UUID NOT NULL PRIMARY KEY REFERENCES "CapabilityVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "retiredAt" TIMESTAMP(3),
  "testingStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
