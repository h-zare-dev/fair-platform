import { randomUUID } from 'node:crypto';
import { createOwnerDataSource } from './infrastructure/database.js';
import { PostgresOwnerAuth } from './infrastructure/auth-store.js';
import { passwords } from './infrastructure/password.js';
import { OwnerAuth } from './application/auth.js';
import { confirmedPassword } from './infrastructure/terminal.js';
import { seedSynthetic } from './infrastructure/seed.js';
import { importPrivateReplayIdentities } from './infrastructure/private-replay-identity.js';
async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (
    (command === 'import-private-replay-identities'
      ? extra.length !== 2
      : extra.length !== 0) ||
    ![
      'bootstrap',
      'reset-password',
      'revoke-sessions',
      'cleanup',
      'migrate',
      'seed',
      'import-private-replay-identities',
    ].includes(command ?? '')
  )
    throw new Error('INVALID_COMMAND');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_REQUIRED');
  const db = createOwnerDataSource(process.env.DATABASE_URL);
  await db.initialize();
  try {
    const store = new PostgresOwnerAuth(db);
    const auth = new OwnerAuth(
      store,
      passwords,
      await passwords.hash(randomUUID()),
    );
    if (command === 'migrate') await db.runMigrations({ transaction: 'all' });
    else if (command === 'import-private-replay-identities') {
      if (process.env.FAIR_SHADOW_ENABLED !== 'true')
        throw new Error('SHADOW_ONLY_IMPORT_REQUIRED');
      const result = await importPrivateReplayIdentities(
        db,
        extra[0]!,
        extra[1]!,
      );
      console.info('PRIVATE_IDENTITY_IMPORT', JSON.stringify(result));
    } else if (command === 'bootstrap') {
      if (await store.passwordHash()) throw new Error('OWNER_ALREADY_EXISTS');
      if (!(await auth.bootstrap(await confirmedPassword())))
        throw new Error('OWNER_ALREADY_EXISTS');
    } else if (command === 'reset-password') {
      if (!(await auth.reset(await confirmedPassword())))
        throw new Error('OWNER_NOT_INITIALIZED');
    } else if (command === 'revoke-sessions') await store.revoke();
    else if (command === 'cleanup') await store.cleanup();
    else if (command === 'seed') {
      if (
        process.env.FAIR_DATA_MODE !== 'synthetic' ||
        !/^[a-fA-F0-9]{64}$/.test(process.env.APP_ENCRYPTION_KEY ?? '')
      )
        throw new Error('SYNTHETIC_CONFIGURATION_REQUIRED');
      await seedSynthetic(db, process.env.APP_ENCRYPTION_KEY!);
    }
    console.info('OWNER_OPERATION_COMPLETE');
  } finally {
    await db.destroy();
  }
}
void main().catch(() => {
  console.error('OWNER_OPERATION_FAILED');
  process.exitCode = 1;
});
