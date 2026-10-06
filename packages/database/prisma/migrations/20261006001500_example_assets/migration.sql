CREATE TABLE "CapabilityExampleAsset" (
  "id" UUID PRIMARY KEY,
  "capabilityId" UUID NOT NULL REFERENCES "Capability"("id"),
  "ownerId" UUID NOT NULL REFERENCES "User"("id"),
  "sourceAssetId" UUID REFERENCES "Asset"("id") ON DELETE SET NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 104857600),
  "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "objectKey" TEXT NOT NULL UNIQUE,
  "scanStatus" TEXT NOT NULL,
  "reusableTemplate" BOOLEAN NOT NULL DEFAULT FALSE,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);
CREATE INDEX "CapabilityExampleAsset_capabilityId_revokedAt_idx" ON "CapabilityExampleAsset"("capabilityId", "revokedAt");
CREATE FUNCTION kivro_protect_example_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['sourceAssetId','revokedAt','deletedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['sourceAssetId','revokedAt','deletedAt'])
    OR (NEW."sourceAssetId" IS DISTINCT FROM OLD."sourceAssetId" AND NEW."sourceAssetId" IS NOT NULL)
    OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
    OR (OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt")
  THEN RAISE EXCEPTION 'Approved example copy is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "example_copy_immutable" BEFORE UPDATE ON "CapabilityExampleAsset"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_example_copy();
