-- Each integration credential acts as a non-interactive service account.
ALTER TABLE `integration_clients` ADD COLUMN `userId` CHAR(36) NULL;
