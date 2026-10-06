ALTER TABLE "Job" ADD COLUMN "pausedDurationMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD CONSTRAINT "pause_duration_nonnegative" CHECK ("pausedDurationMs" >= 0);
