-- Platform control over an organization's API access.
ALTER TABLE `organizations`
    ADD COLUMN `apiAccessEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `apiAllowedScopes` JSON NULL;
