ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_balances_nonnegative" CHECK (
  "availableMinor" >= 0 AND "reservedMinor" >= 0 AND "spentMinor" >= 0 AND "earnedMinor" >= 0
);
ALTER TABLE "Job" ADD CONSTRAINT "job_price_balances" CHECK (
  "buyerPriceMinor" > 0 AND "platformFeeMinor" >= 0 AND "sellerNetMinor" > 0
  AND "buyerPriceMinor" = "platformFeeMinor" + "sellerNetMinor"
);
ALTER TABLE "Review" ADD CONSTRAINT "review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "Capability" ADD CONSTRAINT "capability_capacity_range" CHECK (
  "concurrency" BETWEEN 1 AND 8 AND "maxQueue" BETWEEN 0 AND 100 AND "maxScheduled" BETWEEN 0 AND 100
);
ALTER TABLE "Asset" ADD CONSTRAINT "asset_size_positive" CHECK ("sizeBytes" > 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_currency_usd" CHECK ("currency" = 'USD');

CREATE FUNCTION kivro_reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Financial ledger entries are append-only; create a compensating entry';
END;
$$;
CREATE TRIGGER "ledger_immutable" BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION kivro_reject_ledger_mutation();

CREATE FUNCTION kivro_protect_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."publishedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Published capability versions are immutable; create a new version';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "published_version_immutable" BEFORE UPDATE OR DELETE ON "CapabilityVersion"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_published_version();

CREATE FUNCTION kivro_protect_job_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."buyerId" IS DISTINCT FROM OLD."buyerId"
     OR NEW."sellerId" IS DISTINCT FROM OLD."sellerId"
     OR NEW."capabilityId" IS DISTINCT FROM OLD."capabilityId"
     OR NEW."capabilityVersionId" IS DISTINCT FROM OLD."capabilityVersionId"
     OR NEW."input" IS DISTINCT FROM OLD."input"
     OR NEW."priceSnapshot" IS DISTINCT FROM OLD."priceSnapshot"
     OR NEW."buyerPriceMinor" IS DISTINCT FROM OLD."buyerPriceMinor"
     OR NEW."sellerNetMinor" IS DISTINCT FROM OLD."sellerNetMinor"
     OR NEW."platformFeeMinor" IS DISTINCT FROM OLD."platformFeeMinor"
     OR NEW."executionMode" IS DISTINCT FROM OLD."executionMode"
  THEN RAISE EXCEPTION 'Job ownership, contract, input and price snapshot are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "job_contract_immutable" BEFORE UPDATE ON "Job"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_job_contract();
