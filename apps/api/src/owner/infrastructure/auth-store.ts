import type { DataSource } from 'typeorm';
import type { OwnerAuthStore } from '../application/auth.js';

/** Atomic upsert, transaction advisory locks and UPDATE RETURNING use PostgreSQL-specific SQL.
 * No passwords, tokens, identities or client-supplied text are written to audit.
 */
export class PostgresOwnerAuth implements OwnerAuthStore {
  constructor(private readonly db: DataSource) {}
  async bootstrap(hash: string): Promise<boolean> {
    return this.db.transaction(async (m) => {
      const rows: unknown[] = await m.query(
        'INSERT INTO fair_owner (id,password_hash) VALUES (1,$1) ON CONFLICT DO NOTHING RETURNING id',
        [hash],
      );
      if (!rows.length) return false;
      await m.query(
        "INSERT INTO fair_owner_audit (event) VALUES ('BOOTSTRAP')",
      );
      return true;
    });
  }
  async reset(hash: string): Promise<boolean> {
    return this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(179100003)');
      const owner: unknown[] = await m.query(
        'SELECT id FROM fair_owner WHERE id=1',
      );
      if (!owner.length) return false;
      await m.query('UPDATE fair_owner SET password_hash=$1 WHERE id=1', [
        hash,
      ]);
      await m.query('DELETE FROM fair_owner_sessions');
      await m.query(
        "INSERT INTO fair_owner_audit (event) VALUES ('RESET_PASSWORD')",
      );
      return true;
    });
  }
  async revoke(): Promise<void> {
    await this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(179100003)');
      await m.query('DELETE FROM fair_owner_sessions');
      await m.query(
        "INSERT INTO fair_owner_audit (event) VALUES ('REVOKE_SESSIONS')",
      );
    });
  }
  async attempt(): Promise<boolean> {
    const rows: { attempts: number }[] = await this.db
      .query(`INSERT INTO fair_owner_login_budget (id,started_at,attempts) VALUES (1,clock_timestamp(),1)
      ON CONFLICT (id) DO UPDATE SET
      attempts=CASE WHEN fair_owner_login_budget.started_at <= clock_timestamp()-interval '1 minute' THEN 1 ELSE LEAST(fair_owner_login_budget.attempts+1,11) END,
      started_at=CASE WHEN fair_owner_login_budget.started_at <= clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE fair_owner_login_budget.started_at END
      RETURNING attempts`);
    return (rows[0]?.attempts ?? 11) <= 10;
  }
  async passwordHash(): Promise<string | null> {
    const rows: { password_hash: string }[] = await this.db.query(
      'SELECT password_hash FROM fair_owner WHERE id=1',
    );
    return rows[0]?.password_hash ?? null;
  }
  async login(
    expectedHash: string,
    hash: string,
    previousHash: string | null,
  ): Promise<boolean> {
    return this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(179100003)');
      const rows: { password_hash: string }[] = await m.query(
        'SELECT password_hash FROM fair_owner WHERE id=1',
      );
      if (rows[0]?.password_hash !== expectedHash) return false;
      if (previousHash)
        await m.query('DELETE FROM fair_owner_sessions WHERE token_hash=$1', [
          previousHash,
        ]);
      await m.query(
        "INSERT INTO fair_owner_sessions (token_hash,owner_id,expires_at) VALUES ($1,1,now()+interval '12 hours')",
        [hash],
      );
      await m.query("INSERT INTO fair_owner_audit (event) VALUES ('LOGIN_OK')");
      return true;
    });
  }
  async session(hash: string): Promise<boolean> {
    const result: [unknown[], number] = await this.db.query(
      `UPDATE fair_owner_sessions SET last_seen_at=clock_timestamp()
      WHERE token_hash=$1 AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '30 minutes' RETURNING owner_id`,
      [hash],
    );
    return result[1] === 1;
  }
  async logout(hash: string): Promise<void> {
    await this.db.transaction(async (m) => {
      await m.query('DELETE FROM fair_owner_sessions WHERE token_hash=$1', [
        hash,
      ]);
      await m.query("INSERT INTO fair_owner_audit (event) VALUES ('LOGOUT')");
    });
  }
  async denied(): Promise<void> {
    await this.db.query(
      "INSERT INTO fair_owner_audit (event) VALUES ('LOGIN_DENIED')",
    );
  }
  async cleanup(): Promise<void> {
    await this.db.query(
      "DELETE FROM fair_owner_sessions WHERE expires_at<=now() OR last_seen_at<=now()-interval '30 minutes'",
    );
    await this.db.query(
      "DELETE FROM fair_owner_audit WHERE created_at<now()-interval '30 days'",
    );
  }
}
