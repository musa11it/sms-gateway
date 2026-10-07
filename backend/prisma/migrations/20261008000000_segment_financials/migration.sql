-- Segment-level SMS financials: selling price frozen on customer credit lots, and exact revenue /
-- provider cost lot allocations frozen on each recipient. Additive only.

ALTER TABLE `sms_credit_lots` ADD COLUMN `unitPrice` DECIMAL(14, 4) NULL;

ALTER TABLE `sms_recipients`
  ADD COLUMN `costLots` JSON NULL,
  ADD COLUMN `revenue` DECIMAL(14, 4) NULL,
  ADD COLUMN `revenueLots` JSON NULL;

-- Backfill: purchased lots get the price the customer actually paid for that purchase.
UPDATE `sms_credit_lots` l
  JOIN `wallet_transactions` t ON t.`id` = l.`sourceTransactionId`
  JOIN `payments` p ON t.`reference` = CONCAT('payment:', p.`id`)
SET l.`unitPrice` = COALESCE(p.`unitPrice`, ROUND(p.`amount` / p.`credits`, 4))
WHERE l.`sourceType` = 'PURCHASE' AND p.`credits` > 0;

-- Backfill: messages sent before this change are valued at the customer's average purchase price
-- (no per-lot record exists for them); customers that never paid used free credits (revenue 0).
UPDATE `sms_recipients` r
  LEFT JOIN (
    SELECT `organizationId`, SUM(`revenue`) / SUM(`credits`) AS price
    FROM `customer_purchases` WHERE `credits` > 0 GROUP BY `organizationId`
  ) x ON x.`organizationId` = r.`organizationId`
SET r.`revenue` = ROUND(r.`credits` * COALESCE(x.price, 0), 4)
WHERE r.`revenue` IS NULL;
