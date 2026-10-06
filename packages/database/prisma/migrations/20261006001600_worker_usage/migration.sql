ALTER TABLE "JobAttempt" ADD COLUMN "usageReceipt" JSONB, ADD COLUMN "usageReportedAt" TIMESTAMP(3);
ALTER TABLE "JobAttempt" ADD CONSTRAINT "worker_usage_pair" CHECK (("usageReceipt" IS NULL) = ("usageReportedAt" IS NULL));
CREATE FUNCTION kivro_protect_worker_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."usageReceipt" IS NOT NULL AND
    (NEW."usageReceipt" IS DISTINCT FROM OLD."usageReceipt" OR NEW."usageReportedAt" IS DISTINCT FROM OLD."usageReportedAt")
  THEN RAISE EXCEPTION 'Worker usage receipt is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "worker_usage_immutable" BEFORE UPDATE ON "JobAttempt"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_worker_usage();
