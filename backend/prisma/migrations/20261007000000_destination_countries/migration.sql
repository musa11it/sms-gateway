-- Recipient status REJECTED: never accepted by a provider (refunded), separate from FAILED (delivery failure after acceptance).
ALTER TABLE `sms_recipients` MODIFY `status` ENUM('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED') NOT NULL DEFAULT 'QUEUED';
ALTER TABLE `sms_delivery_reports` MODIFY `status` ENUM('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REJECTED') NOT NULL;

-- Routing decision details kept on each recipient.
ALTER TABLE `sms_recipients` ADD COLUMN `countryCode` CHAR(2) NULL,
    ADD COLUMN `routingNote` VARCHAR(191) NULL;

-- Optional per-network number length rule.
ALTER TABLE `sms_networks` ADD COLUMN `nationalNumberLengths` JSON NULL;

-- Destination countries.
CREATE TABLE `sms_countries` (
    `id` CHAR(36) NOT NULL,
    `isoCode` CHAR(2) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `validationMode` ENUM('STRICT', 'LENGTH') NOT NULL DEFAULT 'STRICT',
    `nationalNumberLengths` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sms_countries_isoCode_key`(`isoCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Explicit provider capability for a whole country.
CREATE TABLE `sms_provider_countries` (
    `providerId` CHAR(36) NOT NULL,
    `countryId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sms_provider_countries_countryId_idx`(`countryId`),
    PRIMARY KEY (`providerId`, `countryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── Carry the existing configuration over ────────────────────────────────

-- Every country that already has networks becomes a configured country.
INSERT INTO `sms_countries` (`id`, `isoCode`, `name`, `isActive`, `validationMode`, `nationalNumberLengths`, `createdAt`, `updatedAt`)
SELECT UUID(), n.`countryCode`, MIN(n.`countryName`), TRUE, 'STRICT', JSON_ARRAY(), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
FROM `sms_networks` n GROUP BY n.`countryCode`;

-- "Serves all destinations" becomes explicit capability for the countries configured today — never "every country".
INSERT INTO `sms_provider_countries` (`providerId`, `countryId`, `createdAt`)
SELECT p.`id`, c.`id`, UTC_TIMESTAMP(3) FROM `sms_providers` p CROSS JOIN `sms_countries` c WHERE p.`servesAllDestinations` = TRUE;
UPDATE `sms_providers` SET `servesAllDestinations` = FALSE WHERE `servesAllDestinations` = TRUE;

-- AddForeignKey
ALTER TABLE `sms_provider_countries` ADD CONSTRAINT `sms_provider_countries_providerId_fkey` FOREIGN KEY (`providerId`) REFERENCES `sms_providers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `sms_provider_countries` ADD CONSTRAINT `sms_provider_countries_countryId_fkey` FOREIGN KEY (`countryId`) REFERENCES `sms_countries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `sms_networks` ADD CONSTRAINT `sms_networks_countryCode_fkey` FOREIGN KEY (`countryCode`) REFERENCES `sms_countries`(`isoCode`) ON DELETE RESTRICT ON UPDATE CASCADE;
