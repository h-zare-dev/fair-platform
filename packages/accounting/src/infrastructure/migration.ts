import type { MigrationInterface, QueryRunner } from 'typeorm';

/** PostgreSQL identity, deferred invariants and append-only triggers require explicit SQL. */
export class AccountingFoundations1791000000000 implements MigrationInterface {
  name = 'AccountingFoundations1791000000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE accounting_transactions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      operation_key varchar(128) NOT NULL,
      posting_scope varchar(16) NOT NULL CHECK (posting_scope = 'SHADOW'),
      entry_type varchar(32) NOT NULL CHECK (entry_type = 'CHARGE'),
      billing_admin_id bigint NOT NULL CHECK (billing_admin_id >= 0),
      external_user_id bigint NOT NULL CHECK (external_user_id >= 0),
      amount_toman bigint NOT NULL CHECK (amount_toman > 0),
      occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      reason_code varchar(64) NOT NULL,
      UNIQUE (source_instance_id, posting_scope, operation_key)
    )`);
    await runner.query(
      `CREATE INDEX accounting_admin_time ON accounting_transactions (source_instance_id, billing_admin_id, occurred_at)`,
    );
    await runner.query(
      `CREATE INDEX accounting_user_time ON accounting_transactions (source_instance_id, external_user_id, occurred_at)`,
    );
    await runner.query(`CREATE TABLE accounting_transaction_events (
      transaction_id bigint NOT NULL REFERENCES accounting_transactions(id),
      event_id bigint NOT NULL REFERENCES pasarguard_events(id),
      PRIMARY KEY (transaction_id, event_id)
    )`);
    await runner.query(
      `CREATE INDEX accounting_event_reference ON accounting_transaction_events(event_id)`,
    );
    await runner.query(`CREATE TABLE accounting_exceptions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      exception_key varchar(128) NOT NULL,
      exception_code varchar(64) NOT NULL CHECK (exception_code IN (
        'PRICING_MISSING','UNEXPECTED_UNLIMITED','PREVIOUS_STATE_MISSING',
        'AMBIGUOUS_CORRELATION','UNKNOWN_WEBHOOK_EVENT')),
      event_id bigint REFERENCES pasarguard_events(id),
      external_user_id bigint CHECK (external_user_id >= 0),
      billing_admin_id bigint CHECK (billing_admin_id >= 0),
      message varchar(128) NOT NULL CHECK (message = CASE exception_code
        WHEN 'PRICING_MISSING' THEN 'Required pricing is missing'
        WHEN 'UNEXPECTED_UNLIMITED' THEN 'Unlimited state requires review'
        WHEN 'PREVIOUS_STATE_MISSING' THEN 'Previous state is missing'
        WHEN 'AMBIGUOUS_CORRELATION' THEN 'Event correlation requires review'
        WHEN 'UNKNOWN_WEBHOOK_EVENT' THEN 'Webhook event requires review' END),
      status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (status = 'OPEN'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_instance_id, exception_key)
    )`);
    await runner.query(
      `CREATE INDEX accounting_exception_code_time ON accounting_exceptions(source_instance_id, exception_code, created_at)`,
    );
    await runner.query(
      `CREATE INDEX accounting_exception_event ON accounting_exceptions(event_id)`,
    );
    await runner.query(`CREATE FUNCTION accounting_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ACCOUNTING_IMMUTABLE'; END $$`);
    for (const table of [
      'accounting_transactions',
      'accounting_transaction_events',
    ]) {
      await runner.query(`CREATE TRIGGER accounting_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION accounting_reject_mutation()`);
    }
    // xmin ensures links are inserted only in the transaction that created the ledger row.
    // Shared locks prevent source identity changes during reference verification.
    await runner.query(`CREATE FUNCTION accounting_validate_link() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ledger accounting_transactions%ROWTYPE; event pasarguard_events%ROWTYPE; fresh boolean;
      BEGIN
        SELECT *, xmin = pg_current_xact_id()::text::xid INTO ledger.id, ledger.source_instance_id,
          ledger.operation_key, ledger.posting_scope, ledger.entry_type, ledger.billing_admin_id,
          ledger.external_user_id, ledger.amount_toman, ledger.occurred_at, ledger.recorded_at,
          ledger.reason_code, fresh FROM accounting_transactions WHERE id = NEW.transaction_id FOR SHARE;
        IF NOT FOUND OR NOT fresh THEN RAISE EXCEPTION 'ACCOUNTING_IMMUTABLE'; END IF;
        SELECT * INTO event FROM pasarguard_events WHERE id = NEW.event_id FOR SHARE;
        IF NOT FOUND OR event.source_instance_id <> ledger.source_instance_id OR event.external_user_id <> ledger.external_user_id
          THEN RAISE EXCEPTION 'INVALID_SOURCE_REFERENCE'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER accounting_link_insert BEFORE INSERT ON accounting_transaction_events
      FOR EACH ROW EXECUTE FUNCTION accounting_validate_link()`);
    await runner.query(`CREATE FUNCTION accounting_require_links() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM accounting_transaction_events WHERE transaction_id = NEW.id)
          THEN RAISE EXCEPTION 'INVALID_SOURCE_REFERENCE'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE CONSTRAINT TRIGGER accounting_at_least_one_event AFTER INSERT ON accounting_transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_require_links()`);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Explicit opt-in for destructive local/test rollback, never runtime configuration.
    await runner.query(`DO $$ BEGIN IF current_setting('fair.accounting_disposable', true) IS DISTINCT FROM 'on'
      THEN RAISE EXCEPTION 'DISPOSABLE_DATABASE_REQUIRED'; END IF; END $$`);
    await runner.query('DROP TABLE accounting_exceptions');
    await runner.query('DROP TABLE accounting_transaction_events');
    await runner.query('DROP TABLE accounting_transactions');
    await runner.query('DROP FUNCTION accounting_require_links()');
    await runner.query('DROP FUNCTION accounting_validate_link()');
    await runner.query('DROP FUNCTION accounting_reject_mutation()');
  }
}
