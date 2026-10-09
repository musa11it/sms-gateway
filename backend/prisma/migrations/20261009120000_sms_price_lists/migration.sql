-- Pricing configurations (price lists) for each network/service/direction: pricing metric, rate application,
-- purchase limits, fee, notes and status. Additive; every existing price list keeps today's rule
-- (purchase quantity, whole purchase, no fee, active) through the defaults and the backfill below.

-- AlterTable
ALTER TABLE `payment_items` ADD COLUMN `breakdown` JSON NULL,
    ADD COLUMN `fee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `metricVolumeBefore` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `priceListId` CHAR(36) NULL,
    ADD COLUMN `pricingMetric` ENUM('PURCHASE_QUANTITY', 'MONTHLY_PURCHASE_QUANTITY') NOT NULL DEFAULT 'PURCHASE_QUANTITY',
    ADD COLUMN `rateApplication` ENUM('WHOLE_PURCHASE', 'GRADUATED') NOT NULL DEFAULT 'WHOLE_PURCHASE';

-- AlterTable
ALTER TABLE `sms_pricing_tiers` ADD COLUMN `service` ENUM('BULK_SMS') NOT NULL DEFAULT 'BULK_SMS';

-- CreateTable
CREATE TABLE `sms_price_lists` (
    `id` CHAR(36) NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
    `networkId` CHAR(36) NULL,
    `service` ENUM('BULK_SMS') NOT NULL DEFAULT 'BULK_SMS',
    `direction` ENUM('OUTBOUND', 'INBOUND') NOT NULL DEFAULT 'OUTBOUND',
    `pricingMetric` ENUM('PURCHASE_QUANTITY', 'MONTHLY_PURCHASE_QUANTITY') NOT NULL DEFAULT 'PURCHASE_QUANTITY',
    `rateApplication` ENUM('WHOLE_PURCHASE', 'GRADUATED') NOT NULL DEFAULT 'WHOLE_PURCHASE',
    `minPurchaseQuantity` INTEGER NULL,
    `maxPurchaseQuantity` INTEGER NULL,
    `purchaseFee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `customerNotes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(36) NULL,
    `updatedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_price_lists_scopeKey_key`(`scopeKey`),
    INDEX `sms_price_lists_networkId_idx`(`networkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sms_price_lists` ADD CONSTRAINT `sms_price_lists_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_items` ADD CONSTRAINT `payment_items_priceListId_fkey` FOREIGN KEY (`priceListId`) REFERENCES `sms_price_lists`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: one explicit configuration for every price list that already has tiers.
INSERT INTO `sms_price_lists` (`id`, `scopeKey`, `networkId`, `service`, `direction`, `createdAt`, `updatedAt`)
SELECT UUID(), CONCAT(COALESCE(t.`networkId`, 'general'), ':BULK_SMS:', t.`direction`), t.`networkId`, 'BULK_SMS', t.`direction`, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
FROM (SELECT DISTINCT `networkId`, `direction` FROM `sms_pricing_tiers`) t;

-- Purchases made before configurations existed were priced by purchase quantity, whole purchase.
UPDATE `payment_items` i
  JOIN `sms_price_lists` l ON l.`scopeKey` = CONCAT(i.`networkId`, ':BULK_SMS:', i.`direction`)
SET i.`priceListId` = l.`id`;
