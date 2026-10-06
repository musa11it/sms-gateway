-- Service accounts, key rotation overlap, idempotency records and integration request logs.
ALTER TABLE `users` ADD COLUMN `isServiceAccount` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `integration_clients`
    ADD COLUMN `previousKeyHash` VARCHAR(191) NULL,
    ADD COLUMN `previousValidUntil` DATETIME(3) NULL,
    ADD COLUMN `rotatedAt` DATETIME(3) NULL;

-- Credentials created before this migration used ordinary-looking accounts; flag them.
UPDATE `users` SET `isServiceAccount` = true WHERE `email` LIKE 'integration-%@service.local';

CREATE TABLE `idempotency_records` (
    `id` CHAR(36) NOT NULL,
    `credentialId` CHAR(36) NOT NULL,
    `key` VARCHAR(100) NOT NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `statusCode` INTEGER NULL,
    `responseBody` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idempotency_records_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `idempotency_records_credentialId_key_key`(`credentialId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `integration_request_logs` (
    `id` CHAR(36) NOT NULL,
    `credentialId` CHAR(36) NOT NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `statusCode` INTEGER NOT NULL,
    `durationMs` INTEGER NOT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `requestId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `integration_request_logs_credentialId_createdAt_idx`(`credentialId`, `createdAt`),
    INDEX `integration_request_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
