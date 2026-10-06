ALTER TABLE "Job"
  ADD COLUMN "originalScheduledAt" TIMESTAMP(3),
  ADD COLUMN "eligibleAt" TIMESTAMP(3),
  ADD COLUMN "queuedAt" TIMESTAMP(3),
  ADD COLUMN "contentDeletedAt" TIMESTAMP(3);
-- Historical original promises are unknown: do not manufacture them by copying
-- a potentially rescheduled current timestamp.
ALTER TABLE "JobEvent" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "WebhookDelivery" ADD COLUMN "failedAt" TIMESTAMP(3);
