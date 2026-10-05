-- Audit logs and wallet ledger entries are append-only.
-- Any UPDATE or DELETE is rejected at the database level, regardless of application bugs.
CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER wallet_transactions_append_only
  BEFORE UPDATE OR DELETE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Wallet balance can never go negative.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_non_negative" CHECK ("balance" >= 0);
