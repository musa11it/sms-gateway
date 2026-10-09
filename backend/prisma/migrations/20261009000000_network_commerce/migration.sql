-- Country/network SMS commerce (additive, backward compatible):
--  * network maintenance state, per-network sender ID registration flag and message directions
--  * pricing tiers per destination network (null = existing general credits) with effective dates
--  * credit lots scoped to a network (null = existing general credits, still usable on any network)
--  * multi-network purchase lines and per-network sender ID approvals
-- Existing rows keep their behaviour: every new column defaults to the current semantics.

-- AlterTable
ALTER TABLE `sms_credit_lots` ADD COLUMN `networkId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `sms_networks` ADD COLUMN `inMaintenance` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maintenanceNote` TEXT NULL,
    ADD COLUMN `requiresSenderRegistration` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `supportsInbound` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `supportsOutbound` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `sms_pricing_tiers` ADD COLUMN `direction` ENUM('OUTBOUND', 'INBOUND') NOT NULL DEFAULT 'OUTBOUND',
    ADD COLUMN `effectiveFrom` DATETIME(3) NULL,
    ADD COLUMN `effectiveTo` DATETIME(3) NULL,
    ADD COLUMN `networkId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `sender_id_networks` (
    `id` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `networkId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'PENDING',
    `note` TEXT NULL,
    `reviewedById` CHAR(36) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sender_id_networks_organizationId_idx`(`organizationId`),
    INDEX `sender_id_networks_networkId_status_idx`(`networkId`, `status`),
    UNIQUE INDEX `sender_id_networks_senderId_networkId_key`(`senderId`, `networkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_items` (
    `id` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `networkId` CHAR(36) NOT NULL,
    `networkName` VARCHAR(191) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `direction` ENUM('OUTBOUND', 'INBOUND') NOT NULL DEFAULT 'OUTBOUND',
    `quantity` INTEGER NOT NULL,
    `pricingTierId` CHAR(36) NOT NULL,
    `tierMinQuantity` INTEGER NOT NULL,
    `tierMaxQuantity` INTEGER NULL,
    `unitPrice` DECIMAL(14, 4) NOT NULL,
    `subtotal` DECIMAL(14, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_items_networkId_idx`(`networkId`),
    UNIQUE INDEX `payment_items_paymentId_networkId_key`(`paymentId`, `networkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `sms_credit_lots_walletId_networkId_remaining_idx` ON `sms_credit_lots`(`walletId`, `networkId`, `remaining`);

-- CreateIndex
CREATE INDEX `sms_pricing_tiers_networkId_direction_isActive_idx` ON `sms_pricing_tiers`(`networkId`, `direction`, `isActive`);

-- AddForeignKey
ALTER TABLE `sender_id_networks` ADD CONSTRAINT `sender_id_networks_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `sender_ids`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sender_id_networks` ADD CONSTRAINT `sender_id_networks_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_pricing_tiers` ADD CONSTRAINT `sms_pricing_tiers_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_credit_lots` ADD CONSTRAINT `sms_credit_lots_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_items` ADD CONSTRAINT `payment_items_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_items` ADD CONSTRAINT `payment_items_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_items` ADD CONSTRAINT `payment_items_pricingTierId_fkey` FOREIGN KEY (`pricingTierId`) REFERENCES `sms_pricing_tiers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Campaign audience limited to selected destination networks (null = any configured network).
ALTER TABLE `campaigns` ADD COLUMN `networkIds` JSON NULL;
