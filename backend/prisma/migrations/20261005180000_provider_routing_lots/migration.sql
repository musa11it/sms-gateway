-- AlterTable
ALTER TABLE `sms_providers` ADD COLUMN `health` ENUM('HEALTHY', 'DEGRADED', 'DOWN') NOT NULL DEFAULT 'HEALTHY',
    ADD COLUMN `healthNote` TEXT NULL,
    ADD COLUMN `minimumCapacity` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `servesAllDestinations` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `supportsSenderId` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `sms_recipients` ADD COLUMN `networkId` CHAR(36) NULL,
    ADD COLUMN `routingRuleId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `sms_networks` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `countryName` VARCHAR(191) NOT NULL,
    `prefixes` JSON NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_networks_code_key`(`code`),
    INDEX `sms_networks_countryCode_idx`(`countryCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_provider_networks` (
    `providerId` CHAR(36) NOT NULL,
    `networkId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sms_provider_networks_networkId_idx`(`networkId`),
    PRIMARY KEY (`providerId`, `networkId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_capacity_lots` (
    `id` CHAR(36) NOT NULL,
    `providerId` CHAR(36) NOT NULL,
    `purchaseId` CHAR(36) NULL,
    `source` ENUM('OPENING', 'PURCHASE', 'ADJUSTMENT', 'RETURN') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `remaining` INTEGER NOT NULL,
    `unitCost` DECIMAL(14, 4) NOT NULL,
    `reference` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `provider_capacity_lots_purchaseId_key`(`purchaseId`),
    INDEX `provider_capacity_lots_providerId_remaining_createdAt_idx`(`providerId`, `remaining`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_lot_consumptions` (
    `id` CHAR(36) NOT NULL,
    `lotId` CHAR(36) NOT NULL,
    `ledgerEntryId` CHAR(36) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `returned` INTEGER NOT NULL DEFAULT 0,
    `unitCost` DECIMAL(14, 4) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `provider_lot_consumptions_ledgerEntryId_idx`(`ledgerEntryId`),
    INDEX `provider_lot_consumptions_lotId_idx`(`lotId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sms_routing_rules` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `priority` INTEGER NOT NULL,
    `countryCode` CHAR(2) NULL,
    `networkId` CHAR(36) NULL,
    `strategy` ENUM('PRIORITY', 'LOWEST_COST', 'PRIORITY_THEN_COST') NOT NULL DEFAULT 'PRIORITY',
    `primaryProviderId` CHAR(36) NULL,
    `backupProviderIds` JSON NOT NULL,
    `allowedProviderIds` JSON NOT NULL,
    `minProviderCapacity` INTEGER NOT NULL DEFAULT 0,
    `maxCostPerSegment` DECIMAL(14, 4) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `description` TEXT NULL,
    `createdById` CHAR(36) NULL,
    `updatedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sms_routing_rules_isActive_priority_idx`(`isActive`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sms_provider_networks` ADD CONSTRAINT `sms_provider_networks_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_provider_networks` ADD CONSTRAINT `sms_provider_networks_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_capacity_lots` ADD CONSTRAINT `provider_capacity_lots_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_capacity_lots` ADD CONSTRAINT `provider_capacity_lots_purchaseId_fkey` FOREIGN KEY (`purchaseId`) REFERENCES `provider_purchases`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_lot_consumptions` ADD CONSTRAINT `provider_lot_consumptions_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `provider_capacity_lots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_lot_consumptions` ADD CONSTRAINT `provider_lot_consumptions_ledgerEntryId_fkey` FOREIGN KEY (`ledgerEntryId`) REFERENCES `provider_capacity_ledger`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_routing_rules` ADD CONSTRAINT `sms_routing_rules_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_routing_rules` ADD CONSTRAINT `sms_routing_rules_primaryProviderId_fkey` FOREIGN KEY (`primaryProviderId`) REFERENCES `sms_providers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_recipients` ADD CONSTRAINT `sms_recipients_routingRuleId_fkey` FOREIGN KEY (`routingRuleId`) REFERENCES `sms_routing_rules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sms_recipients` ADD CONSTRAINT `sms_recipients_networkId_fkey` FOREIGN KEY (`networkId`) REFERENCES `sms_networks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Integrity rules
-- ─────────────────────────────────────────────────────────────

-- Provider capacity can never go negative (overdraft is no longer used by routing).
ALTER TABLE `sms_providers` DROP CHECK `sms_providers_capacity_floor`;
ALTER TABLE `sms_providers` ADD CONSTRAINT `sms_providers_capacity_non_negative` CHECK (`capacityBalance` >= 0 AND `minimumCapacity` >= 0);
ALTER TABLE `provider_capacity_lots` ADD CONSTRAINT `provider_capacity_lots_bounds` CHECK (`quantity` > 0 AND `remaining` >= 0 AND `remaining` <= `quantity` AND `unitCost` >= 0);
ALTER TABLE `provider_lot_consumptions` ADD CONSTRAINT `provider_lot_consumptions_bounds` CHECK (`quantity` > 0 AND `returned` >= 0 AND `returned` <= `quantity`);
ALTER TABLE `sms_routing_rules` ADD CONSTRAINT `sms_routing_rules_limits` CHECK (`minProviderCapacity` >= 0 AND (`maxCostPerSegment` IS NULL OR `maxCostPerSegment` >= 0));

-- ─────────────────────────────────────────────────────────────
-- Data: carry the existing configuration over
-- ─────────────────────────────────────────────────────────────

-- Destination networks the previous prefix configuration referred to.
INSERT INTO `sms_networks` (`id`, `code`, `name`, `countryCode`, `countryName`, `prefixes`, `isActive`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'RW-MTN', 'MTN Rwanda', 'RW', 'Rwanda', JSON_ARRAY('+25078', '+25079'), TRUE, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)),
  (UUID(), 'RW-AIRTEL', 'Airtel Rwanda', 'RW', 'Rwanda', JSON_ARRAY('+25072', '+25073'), TRUE, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));

-- Capability: a provider serves the networks its old prefixes covered; no prefixes meant "any destination".
INSERT INTO `sms_provider_networks` (`providerId`, `networkId`, `createdAt`)
SELECT p.`id`, n.`id`, UTC_TIMESTAMP(3) FROM `sms_providers` p JOIN `sms_networks` n ON JSON_OVERLAPS(p.`routePrefixes`, n.`prefixes`);
UPDATE `sms_providers` SET `servesAllDestinations` = TRUE WHERE JSON_LENGTH(`routePrefixes`) = 0;

-- Capacity lots: one per successful purchase at its original unit cost. The current balance is
-- attributed to the newest purchases (older capacity is consumed first).
INSERT INTO `provider_capacity_lots` (`id`, `providerId`, `purchaseId`, `source`, `quantity`, `remaining`, `unitCost`, `reference`, `createdAt`, `updatedAt`)
SELECT UUID(), x.`providerId`, x.`id`, 'PURCHASE', x.`quantity`, LEAST(x.`quantity`, GREATEST(0, x.`balance` - x.`newer`)), x.`unitCost`, x.`reference`, x.`at`, UTC_TIMESTAMP(3)
FROM (
  SELECT pp.`id`, pp.`providerId`, pp.`quantity`, pp.`unitCost`, pp.`reference`, COALESCE(pp.`completedAt`, pp.`createdAt`) AS `at`, p.`capacityBalance` AS `balance`,
    COALESCE(SUM(pp.`quantity`) OVER (PARTITION BY pp.`providerId` ORDER BY COALESCE(pp.`completedAt`, pp.`createdAt`) DESC, pp.`id` DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS `newer`
  FROM `provider_purchases` pp JOIN `sms_providers` p ON p.`id` = pp.`providerId`
  WHERE pp.`status` = 'SUCCESS'
) x;

-- Capacity not explained by purchases (positive adjustments) becomes an opening lot at the configured cost.
INSERT INTO `provider_capacity_lots` (`id`, `providerId`, `purchaseId`, `source`, `quantity`, `remaining`, `unitCost`, `reference`, `createdAt`, `updatedAt`)
SELECT UUID(), p.`id`, NULL, 'OPENING', p.`capacityBalance` - COALESCE(l.`remaining`, 0), p.`capacityBalance` - COALESCE(l.`remaining`, 0), p.`costPerSms`, 'opening-balance', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
FROM `sms_providers` p
LEFT JOIN (SELECT `providerId`, SUM(`remaining`) AS `remaining` FROM `provider_capacity_lots` GROUP BY `providerId`) l ON l.`providerId` = p.`id`
WHERE p.`capacityBalance` > COALESCE(l.`remaining`, 0);
