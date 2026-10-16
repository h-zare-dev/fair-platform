import { randomBytes } from 'node:crypto';
import { createOwnerDataSource } from './infrastructure/database.js';
import { PostgresOwnerAuth } from './infrastructure/auth-store.js';
import { tokenHash } from './application/auth.js';
// Trusted console-only temporary session, never exported to CI or printed.
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_REQUIRED');
  const db = createOwnerDataSource(process.env.DATABASE_URL);
  await db.initialize();
  const store = new PostgresOwnerAuth(db);
  const token = randomBytes(32).toString('base64url');
  try {
    const hash = await store.passwordHash();
    if (!hash || !(await store.login(hash, tokenHash(token), null)))
      throw new Error('OWNER_NOT_INITIALIZED');
    await db.query(
      "UPDATE fair_owner_sessions SET expires_at=now()+interval '2 minutes' WHERE token_hash=$1",
      [tokenHash(token)],
    );
    for (const path of [
      '/api/v1/owner/auth/session',
      '/api/v1/owner/operations/summary',
      '/dashboard',
    ]) {
      const response = await fetch('https://panel.fairisfair.ir' + path, {
        headers: { Cookie: `__Host-fair_owner=${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (
        !response.ok ||
        response.headers.get('cache-control')?.includes('public')
      )
        throw new Error('SMOKE_FAILED');
      if (
        path === '/dashboard' &&
        !(await response.text()).includes('NO LIVE BILLING')
      )
        throw new Error('SMOKE_FAILED');
    }
    console.info('AUTHENTICATED_SMOKE_OK');
  } finally {
    await store.logout(tokenHash(token));
    await db.destroy();
  }
}
void main().catch(() => {
  console.error('AUTHENTICATED_SMOKE_FAILED');
  process.exitCode = 1;
});
