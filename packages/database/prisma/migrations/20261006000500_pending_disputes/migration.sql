ALTER TABLE "BillingEvent"
  ADD COLUMN "providerReference" TEXT,
  ADD COLUMN "payload" JSONB,
  ALTER COLUMN "processedAt" DROP NOT NULL;
CREATE INDEX "BillingEvent_providerReference_outcome_idx"
  ON "BillingEvent"("providerReference", "outcome");
ALTER TABLE "Topup" ADD COLUMN "disputedAt" TIMESTAMP(3);
UPDATE "Topup" SET "disputedAt" = "createdAt" WHERE "state" = 'DISPUTED';
