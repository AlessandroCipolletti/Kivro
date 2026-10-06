CREATE TABLE "AbuseBucket" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "hits" INTEGER NOT NULL DEFAULT 0 CHECK ("hits" >= 0),
  "amountMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("amountMinor" >= 0),
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AbuseBucket_expiresAt_idx" ON "AbuseBucket"("expiresAt");
