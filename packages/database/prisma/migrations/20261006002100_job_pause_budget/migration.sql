ALTER TABLE "Job" ADD COLUMN "maxPauseMs" INTEGER NOT NULL DEFAULT 900000;
ALTER TABLE "Job" ADD CONSTRAINT "job_pause_budget_range" CHECK ("maxPauseMs" BETWEEN 1000 AND 900000);

CREATE FUNCTION kivro_protect_job_pause_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."maxPauseMs" IS DISTINCT FROM OLD."maxPauseMs" THEN
    RAISE EXCEPTION 'Job pause budget is immutable';
  END IF;
  IF NEW."pausedDurationMs" < OLD."pausedDurationMs" THEN
    RAISE EXCEPTION 'Job cumulative pause duration cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "job_pause_budget_immutable" BEFORE UPDATE ON "Job"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_job_pause_budget();
