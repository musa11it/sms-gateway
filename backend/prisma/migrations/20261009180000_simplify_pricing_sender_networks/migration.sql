-- 1. No fees: customers pay quantity x price per SMS only (drops the per-purchase fee columns added in
--    20261009120000, never used outside tests).
-- 2. Sender IDs can be requested for specific telecoms (restrictToNetworks); existing sender IDs keep
--    working on every network (default false).

-- AlterTable
ALTER TABLE `payment_items` DROP COLUMN `fee`;

-- AlterTable
ALTER TABLE `sender_ids` ADD COLUMN `restrictToNetworks` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `sms_price_lists` DROP COLUMN `purchaseFee`;

