ALTER TABLE "Job" ADD COLUMN "contentRetentionDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Job" ADD CONSTRAINT "job_retention_bounds" CHECK ("contentRetentionDays" BETWEEN 1 AND 3650);

CREATE OR REPLACE FUNCTION kivro_protect_job_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE erasing BOOLEAN;
BEGIN
  erasing := OLD."contentDeletedAt" IS NULL AND NEW."contentDeletedAt" IS NOT NULL
    AND OLD."completedAt" IS NOT NULL
    AND OLD."completedAt" + make_interval(days => OLD."contentRetentionDays") <= CURRENT_TIMESTAMP
    AND OLD."state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
    AND NEW."state" = OLD."state" AND NEW."input" = '{}'::jsonb
    AND (NEW."output" IS NULL OR NEW."output" = 'null'::jsonb);
  IF NEW."buyerId" IS DISTINCT FROM OLD."buyerId"
     OR NEW."sellerId" IS DISTINCT FROM OLD."sellerId"
     OR NEW."capabilityId" IS DISTINCT FROM OLD."capabilityId"
     OR NEW."capabilityVersionId" IS DISTINCT FROM OLD."capabilityVersionId"
     OR (NEW."input" IS DISTINCT FROM OLD."input" AND NOT erasing)
     OR (NEW."contentDeletedAt" IS DISTINCT FROM OLD."contentDeletedAt" AND NOT erasing)
     OR NEW."contentRetentionDays" IS DISTINCT FROM OLD."contentRetentionDays"
     OR NEW."priceSnapshot" IS DISTINCT FROM OLD."priceSnapshot"
     OR NEW."buyerPriceMinor" IS DISTINCT FROM OLD."buyerPriceMinor"
     OR NEW."sellerNetMinor" IS DISTINCT FROM OLD."sellerNetMinor"
     OR NEW."platformFeeMinor" IS DISTINCT FROM OLD."platformFeeMinor"
     OR NEW."executionMode" IS DISTINCT FROM OLD."executionMode"
     OR (OLD."contentDeletedAt" IS NOT NULL AND NEW."output" IS DISTINCT FROM OLD."output")
  THEN RAISE EXCEPTION 'Job ownership, contract, input and price snapshot are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "ProblemReport" (
  "id" UUID PRIMARY KEY,
  "reporterId" UUID NOT NULL REFERENCES "User"("id"),
  "jobId" UUID REFERENCES "Job"("id"),
  "capabilityId" UUID REFERENCES "Capability"("id"),
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "resolution" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "problem_report_target" CHECK (("jobId" IS NULL) <> ("capabilityId" IS NULL)),
  CONSTRAINT "problem_report_status" CHECK ("status" IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED'))
);
CREATE INDEX "ProblemReport_reporterId_createdAt_idx" ON "ProblemReport"("reporterId", "createdAt");
CREATE INDEX "ProblemReport_status_createdAt_idx" ON "ProblemReport"("status", "createdAt");
