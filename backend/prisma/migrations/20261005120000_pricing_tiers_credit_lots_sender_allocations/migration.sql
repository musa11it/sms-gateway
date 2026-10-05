-- AlterTable
ALTER TABLE `payments` ADD COLUMN `creditValidityDays` INTEGER NULL,
    ADD COLUMN `pricingTierId` CHAR(36) NULL,
    ADD COLUMN `tierMaxQuantity` INTEGER NULL,
    ADD COLUMN `tierMinQuantity` INTEGER NULL,
    ADD COLUMN `unitPrice` DECIMAL(14, 4) NULL;

-- CreateTable
CREATE TABLE `sender_id_allocations` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `allocated` INTEGER NOT NULL,
    `used` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `alertThresholds` JSON NOT NULL,
    `lastAlertThreshold` INTEGER NULL,
    `createdById` CHAR(36) NULL,
    `updatedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sender_id_allocations_senderId_key`(`senderId`),
    INDEX `sender_id_allocations_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_pricing_tiers` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NULL,
    `minQuantity` INTEGER NOT NULL,
    `maxQuantity` INTEGER NULL,
    `unitPrice` DECIMAL(14, 4) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'RWF',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` CHAR(36) NULL,
    `updatedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sms_pricing_tiers_isActive_minQuantity_idx`(`isActive`, `minQuantity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_credit_lots` (
    `id` CHAR(36) NOT NULL,
    `walletId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `sourceTransactionId` CHAR(36) NULL,
    `sourceType` ENUM('PURCHASE', 'SMS_DEBIT', 'REFUND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ADJUSTMENT', 'EXPIRATION') NOT NULL,
    `credits` INTEGER NOT NULL,
    `remaining` INTEGER NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_credit_lots_sourceTransactionId_key`(`sourceTransactionId`),
    INDEX `sms_credit_lots_walletId_remaining_expiresAt_idx`(`walletId`, `remaining`, `expiresAt`),
    INDEX `sms_credit_lots_expiresAt_remaining_idx`(`expiresAt`, `remaining`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sender_id_allocations` ADD CONSTRAINT `sender_id_allocations_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sender_id_allocations` ADD CONSTRAINT `sender_id_allocations_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `sender_ids`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_credit_lots` ADD CONSTRAINT `sms_credit_lots_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_pricingTierId_fkey` FOREIGN KEY (`pricingTierId`) REFERENCES `sms_pricing_tiers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Integrity rules
-- ─────────────────────────────────────────────────────────────

ALTER TABLE `sms_pricing_tiers` ADD CONSTRAINT `sms_pricing_tiers_valid_range`
  CHECK (`minQuantity` >= 1 AND (`maxQuantity` IS NULL OR `maxQuantity` >= `minQuantity`) AND `unitPrice` >= 0);
ALTER TABLE `sms_credit_lots` ADD CONSTRAINT `sms_credit_lots_remaining_bounds` CHECK (`remaining` >= 0 AND `remaining` <= `credits`);
ALTER TABLE `sender_id_allocations` ADD CONSTRAINT `sender_id_allocations_used_bounds` CHECK (`used` >= 0 AND `used` <= `allocated`);

-- Existing balances predate credit lots: carry each one over as a single non-expiring lot,
-- so that wallet balance = sum of lot remaining holds from the start.
INSERT INTO `sms_credit_lots` (`id`, `walletId`, `organizationId`, `sourceTransactionId`, `sourceType`, `credits`, `remaining`, `expiresAt`, `createdAt`, `updatedAt`)
SELECT UUID(), `id`, `organizationId`, NULL, 'ADJUSTMENT', `balance`, `balance`, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
FROM `wallets` WHERE `balance` > 0;
