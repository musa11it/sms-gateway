-- Routing strategies: LOWEST_COST, PRIORITY and PRIMARY_BACKUP. Each strategy uses only its own fields.
ALTER TABLE `sms_routing_rules` MODIFY `strategy` ENUM('PRIORITY', 'LOWEST_COST', 'PRIORITY_THEN_COST', 'PRIMARY_BACKUP') NOT NULL DEFAULT 'PRIORITY';

-- Rules with a primary or backups were already routed by that explicit list (it overrode the strategy):
-- keep that behaviour by naming it, and drop the provider pool that was being ignored.
UPDATE `sms_routing_rules`
SET `strategy` = 'PRIMARY_BACKUP', `allowedProviderIds` = JSON_ARRAY()
WHERE `primaryProviderId` IS NOT NULL OR JSON_LENGTH(`backupProviderIds`) > 0;

-- A backups-only list keeps its order: the first backup becomes the primary.
UPDATE `sms_routing_rules`
SET `primaryProviderId` = JSON_UNQUOTE(JSON_EXTRACT(`backupProviderIds`, '$[0]')), `backupProviderIds` = JSON_REMOVE(`backupProviderIds`, '$[0]')
WHERE `strategy` = 'PRIMARY_BACKUP' AND `primaryProviderId` IS NULL AND JSON_LENGTH(`backupProviderIds`) > 0;

-- "Priority, then cost" is Priority (cost is now always the tie-breaker).
UPDATE `sms_routing_rules` SET `strategy` = 'PRIORITY' WHERE `strategy` = 'PRIORITY_THEN_COST';

ALTER TABLE `sms_routing_rules` MODIFY `strategy` ENUM('PRIORITY', 'LOWEST_COST', 'PRIMARY_BACKUP') NOT NULL DEFAULT 'PRIORITY';

-- (PRIMARY_BACKUP requiring a primary is validated by the routing service: MySQL does not allow
-- CHECK constraints on a column used by a cascading foreign key.)
