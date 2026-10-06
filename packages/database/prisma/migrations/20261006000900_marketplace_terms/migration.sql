ALTER TABLE "User"
  ADD COLUMN "termsAcceptedVersion" TEXT,
  ADD COLUMN "termsAcceptedHash" TEXT,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD CONSTRAINT "User_terms_acceptance_complete" CHECK (
    ("termsAcceptedVersion" IS NULL AND "termsAcceptedHash" IS NULL AND "termsAcceptedAt" IS NULL)
    OR ("termsAcceptedVersion" IS NOT NULL AND "termsAcceptedHash" ~ '^[a-f0-9]{64}$' AND "termsAcceptedAt" IS NOT NULL)
  );
