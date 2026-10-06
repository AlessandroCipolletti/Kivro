-- Existing marketplace balances are USD; connected-account payouts retain
-- their independently reported currency and are not converted here.
ALTER TABLE "Wallet" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Topup" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "SellerTransfer" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Job" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "AbuseBucket" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_supported_currency" CHECK ("currency" = 'USD');
ALTER TABLE "Topup" ADD CONSTRAINT "Topup_supported_currency" CHECK ("currency" = 'USD');
ALTER TABLE "SellerTransfer" ADD CONSTRAINT "SellerTransfer_supported_currency" CHECK ("currency" = 'USD');
ALTER TABLE "Job" ADD CONSTRAINT "Job_supported_currency" CHECK ("currency" = 'USD');
ALTER TABLE "AbuseBucket" ADD CONSTRAINT "AbuseBucket_supported_currency" CHECK ("currency" = 'USD');
