ALTER TABLE "CapabilityVersion" ADD COLUMN "publicationEvidence" JSONB;
-- The existing published_version_immutable trigger protects this snapshot too.
-- Historical versions stay null: their publication environment cannot be reconstructed.
