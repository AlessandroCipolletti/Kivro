CREATE TABLE "PaymentDispute" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "paymentIntentId" TEXT NOT NULL,
  "topupId" UUID,
  "livemode" BOOLEAN NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "lastEventCreated" INTEGER NOT NULL,
  "lastEventId" TEXT NOT NULL,
  "closedStatus" TEXT,
  "closedEventCreated" INTEGER,
  "withdrawnEventCreated" INTEGER,
  "reinstatedEventCreated" INTEGER,
  "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentDispute_topupId_fkey" FOREIGN KEY ("topupId") REFERENCES "Topup"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "PaymentDispute_amount_nonnegative" CHECK ("amountMinor" >= 0)
);
CREATE INDEX "PaymentDispute_paymentIntentId_livemode_idx" ON "PaymentDispute"("paymentIntentId", "livemode");
CREATE INDEX "PaymentDispute_topupId_idx" ON "PaymentDispute"("topupId");

-- Prior signed created events establish an unresolved case, never closure proof.
INSERT INTO "PaymentDispute" ("id", "paymentIntentId", "topupId", "livemode", "amountMinor", "currency", "status", "lastEventCreated", "lastEventId", "reviewRequired")
SELECT DISTINCT ON (e."payload"->>'disputeId')
  e."payload"->>'disputeId', e."providerReference", t."id", e."livemode",
  CASE WHEN e."payload"->>'amountMinor' ~ '^[0-9]{1,9}$' THEN (e."payload"->>'amountMinor')::INTEGER ELSE 0 END,
  COALESCE(e."payload"->>'currency', 'unknown'), 'needs_response', 0, e."id",
  NOT (COALESCE(e."payload"->>'currency', '') = 'usd' AND COALESCE(e."payload"->>'amountMinor', '') ~ '^[1-9][0-9]{0,8}$')
FROM "BillingEvent" e LEFT JOIN "Topup" t ON t."paymentIntentId" = e."providerReference" AND t."livemode" = e."livemode"
WHERE e."type" = 'charge.dispute.created' AND e."providerReference" IS NOT NULL AND e."payload"->>'disputeId' IS NOT NULL
ORDER BY e."payload"->>'disputeId', e."processedAt" DESC NULLS LAST;

-- Incomplete legacy records must not silently lose an existing financial hold.
INSERT INTO "PaymentDispute" ("id", "paymentIntentId", "topupId", "livemode", "amountMinor", "currency", "status", "lastEventCreated", "lastEventId", "reviewRequired")
SELECT 'legacy:' || t."id", COALESCE(t."paymentIntentId", 'legacy:' || t."id"), t."id", t."livemode", t."amountMinor", 'usd', 'LEGACY_UNRESOLVED', 0, 'legacy', true
FROM "Topup" t WHERE t."disputedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PaymentDispute" d WHERE d."topupId" = t."id");
