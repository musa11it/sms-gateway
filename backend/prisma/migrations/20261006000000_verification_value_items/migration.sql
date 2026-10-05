-- Verification items can now be a link, text, date or choice instead of a stored file.
ALTER TABLE `verification_documents`
    ADD COLUMN `value` TEXT NULL,
    MODIFY `mimeType` VARCHAR(191) NULL,
    MODIFY `sizeBytes` INTEGER NULL,
    MODIFY `storageKey` VARCHAR(191) NULL,
    MODIFY `checksum` VARCHAR(191) NULL;
