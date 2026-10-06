ALTER TABLE "WorkerCommand" ADD COLUMN "resumeWhilePaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkerCommand" ADD CONSTRAINT "resume_confirmation_scope"
  CHECK (NOT "resumeWhilePaused" OR ("type" = 'RESUME_JOB' AND "jobId" IS NOT NULL));
