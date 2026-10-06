ALTER TABLE "Job" ADD COLUMN "executionRevokedAt" TIMESTAMP(3);
CREATE FUNCTION protect_execution_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."executionRevokedAt" IS NOT NULL AND NEW."executionRevokedAt" IS DISTINCT FROM OLD."executionRevokedAt" THEN
    RAISE EXCEPTION 'Job execution revocation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Job_execution_revocation_immutable" BEFORE UPDATE ON "Job"
FOR EACH ROW EXECUTE FUNCTION protect_execution_revocation();
