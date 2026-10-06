ALTER TABLE "WorkerBinding"
  ADD COLUMN "validationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "validatedManifestHash" TEXT,
  ADD COLUMN "validatedAt" TIMESTAMP(3),
  ADD COLUMN "validationProof" JSONB;

-- Previous heartbeats cannot constitute manifest-specific test evidence.
UPDATE "WorkerBinding" SET "healthy" = false;
ALTER TABLE "WorkerBinding" ADD CONSTRAINT "WorkerBinding_validation_status"
  CHECK ("validationStatus" IN ('PENDING', 'PASSED', 'FAILED'));

ALTER TABLE "BillingEvent"
  ADD COLUMN "livemode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'PROCESSED';
ALTER TABLE "Topup"
  ADD COLUMN "livemode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "refundedMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundAppliedMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundDebtMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Topup" ADD CONSTRAINT "Topup_refund_bounds"
  CHECK ("refundedMinor" >= 0 AND "refundedMinor" <= "amountMinor"
    AND "refundDebtMinor" >= 0 AND "refundDebtMinor" <= "refundedMinor"
    AND "refundAppliedMinor" >= 0 AND "refundAppliedMinor" <= "refundedMinor");
