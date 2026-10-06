ALTER TABLE "WorkerDevice" ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN';
CREATE TABLE "PayoutRecord" (
  "id" UUID PRIMARY KEY,
  "sellerId" UUID NOT NULL REFERENCES "User"("id"),
  "stripeAccountId" TEXT NOT NULL,
  "stripePayoutId" TEXT NOT NULL,
  "livemode" BOOLEAN NOT NULL,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" >= 0),
  "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "status" TEXT NOT NULL CHECK ("status" IN ('pending','in_transit','paid','failed','canceled')),
  "providerCreatedAt" TIMESTAMP(3) NOT NULL,
  "arrivalDate" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PayoutRecord_livemode_stripeAccountId_stripePayoutId_key" ON "PayoutRecord"("livemode", "stripeAccountId", "stripePayoutId");
CREATE INDEX "PayoutRecord_sellerId_livemode_status_idx" ON "PayoutRecord"("sellerId", "livemode", "status");
CREATE INDEX "PayoutRecord_sellerId_providerCreatedAt_idx" ON "PayoutRecord"("sellerId", "providerCreatedAt");
CREATE FUNCTION kivro_protect_payout_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sellerId" IS DISTINCT FROM OLD."sellerId" OR NEW."stripeAccountId" IS DISTINCT FROM OLD."stripeAccountId"
    OR NEW."stripePayoutId" IS DISTINCT FROM OLD."stripePayoutId" OR NEW."livemode" IS DISTINCT FROM OLD."livemode"
    OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."providerCreatedAt" IS DISTINCT FROM OLD."providerCreatedAt"
  THEN RAISE EXCEPTION 'Payout identity and amount are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payout_identity_immutable" BEFORE UPDATE ON "PayoutRecord"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_payout_identity();
