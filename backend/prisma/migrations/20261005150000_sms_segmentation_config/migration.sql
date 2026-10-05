-- CreateTable
CREATE TABLE `sms_segmentation_configs` (
    `version` INTEGER NOT NULL,
    `gsm7SingleSegment` INTEGER NOT NULL,
    `gsm7MultiSegment` INTEGER NOT NULL,
    `ucs2SingleSegment` INTEGER NOT NULL,
    `ucs2MultiSegment` INTEGER NOT NULL,
    `maxMessageCharacters` INTEGER NOT NULL,
    `reason` TEXT NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`version`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `sms_messages` ADD COLUMN `segmentationVersion` INTEGER NULL;

-- Version 1 = the limits the platform used before they became configurable (3GPP defaults),
-- so every existing message is attributed to the rules it was actually billed with.
INSERT INTO `sms_segmentation_configs` (`version`, `gsm7SingleSegment`, `gsm7MultiSegment`, `ucs2SingleSegment`, `ucs2MultiSegment`, `maxMessageCharacters`, `reason`, `createdAt`)
VALUES (1, 160, 153, 70, 67, 1600, 'Initial configuration (limits previously fixed in code)', UTC_TIMESTAMP(3));
UPDATE `sms_messages` SET `segmentationVersion` = 1 WHERE `segmentationVersion` IS NULL;

-- AddForeignKey
ALTER TABLE `sms_messages` ADD CONSTRAINT `sms_messages_segmentationVersion_fkey` FOREIGN KEY (`segmentationVersion`) REFERENCES `sms_segmentation_configs`(`version`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Safety limits: never above what one SMS part physically carries, multipart ≤ single, sane maximum length.
ALTER TABLE `sms_segmentation_configs` ADD CONSTRAINT `sms_segmentation_configs_limits` CHECK (
  `version` >= 1
  AND `gsm7SingleSegment` BETWEEN 10 AND 160 AND `gsm7MultiSegment` BETWEEN 10 AND 153 AND `gsm7MultiSegment` <= `gsm7SingleSegment`
  AND `ucs2SingleSegment` BETWEEN 10 AND 70 AND `ucs2MultiSegment` BETWEEN 10 AND 67 AND `ucs2MultiSegment` <= `ucs2SingleSegment`
  AND `maxMessageCharacters` BETWEEN 10 AND 10000
);

-- Billing history depends on these rows: they are append-only.
CREATE TRIGGER `sms_segmentation_configs_no_update` BEFORE UPDATE ON `sms_segmentation_configs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table sms_segmentation_configs is append-only (UPDATE is not allowed)';
CREATE TRIGGER `sms_segmentation_configs_no_delete` BEFORE DELETE ON `sms_segmentation_configs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table sms_segmentation_configs is append-only (DELETE is not allowed)';
