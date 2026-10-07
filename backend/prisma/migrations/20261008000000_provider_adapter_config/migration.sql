-- Dynamic provider integrations: adapter type and its configuration live on the provider row.
ALTER TABLE `sms_providers`
  ADD COLUMN `adapterType` VARCHAR(191) NOT NULL DEFAULT 'NONE',
  ADD COLUMN `adapterConfig` JSON NULL;
