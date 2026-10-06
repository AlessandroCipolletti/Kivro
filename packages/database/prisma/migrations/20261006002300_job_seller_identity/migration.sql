ALTER TABLE "Job" ADD COLUMN "sellerNameSnapshot" TEXT;

-- Existing jobs have no historical name evidence; do not backfill current profiles.
ALTER TABLE "Job" ADD CONSTRAINT "Job_seller_name_snapshot_length"
  CHECK ("sellerNameSnapshot" IS NULL OR char_length("sellerNameSnapshot") BETWEEN 1 AND 100);

CREATE FUNCTION kivro_protect_job_seller_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sellerNameSnapshot" IS DISTINCT FROM OLD."sellerNameSnapshot" THEN
    RAISE EXCEPTION 'The purchased seller identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "job_seller_name_immutable" BEFORE UPDATE ON "Job"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_job_seller_name();
