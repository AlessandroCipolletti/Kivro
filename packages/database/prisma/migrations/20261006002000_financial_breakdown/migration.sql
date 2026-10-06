ALTER TABLE "Job" ADD COLUMN "financialBreakdown" JSONB NOT NULL DEFAULT '{}';

CREATE FUNCTION kivro_prepaid_financial_breakdown(retail INTEGER, seller_net INTEGER, marketplace_fee INTEGER, currency TEXT)
RETURNS JSONB LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 1, 'currency', currency, 'baseRetailMinor', retail,
    'taxMinor', NULL, 'taxAssessment', 'UNASSESSED',
    'buyerTotalMinor', retail, 'buyerTotalBasis', 'PREPAID_CREDIT_RESERVATION',
    'sellerEntitlementMinor', seller_net, 'marketplaceFeeMinor', marketplace_fee,
    'paymentProcessingFeeMinor', NULL, 'paymentProcessingFeeAttribution', 'NOT_ATTRIBUTED_TO_JOB',
    'processingFeeBearer', 'PLATFORM'
  );
$$;

-- Add explicit interpretation to existing amounts; do not invent taxes,
-- provider invoice costs, a new charge, or a different commercial split.
UPDATE "Job" SET "financialBreakdown" = kivro_prepaid_financial_breakdown(
  "buyerPriceMinor", "sellerNetMinor", "platformFeeMinor", "currency"
);

CREATE FUNCTION kivro_protect_financial_breakdown() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."financialBreakdown" IS DISTINCT FROM OLD."financialBreakdown" THEN
      RAISE EXCEPTION 'Job financial breakdown is immutable';
    END IF;
  ELSE
    expected := kivro_prepaid_financial_breakdown(NEW."buyerPriceMinor", NEW."sellerNetMinor", NEW."platformFeeMinor", NEW."currency");
    IF NEW."financialBreakdown" = '{}'::jsonb THEN NEW."financialBreakdown" := expected; END IF;
    IF NEW."financialBreakdown" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Job financial breakdown does not match the prepaid policy';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "job_financial_breakdown_immutable" BEFORE INSERT OR UPDATE ON "Job"
  FOR EACH ROW EXECUTE FUNCTION kivro_protect_financial_breakdown();
