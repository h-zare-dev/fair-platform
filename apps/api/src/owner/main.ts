import { z } from 'zod';
import { createOwnerDataSource } from './infrastructure/database.js';
import { PostgresOwnerAuth } from './infrastructure/auth-store.js';
import { PostgresOwnerOperations } from './infrastructure/operations.js';
import { passwords } from './infrastructure/password.js';
import { OwnerAuth } from './application/auth.js';
import { createOwnerApi } from './app.js';
async function main() {
  const config = z
    .object({
      DATABASE_URL: z.string().min(1),
      OWNER_ORIGIN: z.literal('https://panel.fairisfair.ir'),
    })
    .parse(process.env);
  const db = createOwnerDataSource(config.DATABASE_URL);
  await db.initialize();
  try {
    const store = new PostgresOwnerAuth(db);
    const auth = new OwnerAuth(
      store,
      passwords,
      await passwords.hash('dummy-' + crypto.randomUUID()),
    );
    const app = await createOwnerApi(
      auth,
      new PostgresOwnerOperations(db),
      config.OWNER_ORIGIN,
    );
    const cleanup = setInterval(() => {
      void store.cleanup().catch(() => console.error('OWNER_CLEANUP_FAILED'));
    }, 60000);
    cleanup.unref();
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onClose', async () => {
        clearInterval(cleanup);
        if (db.isInitialized) await db.destroy();
      });
    await app.listen({ host: '0.0.0.0', port: 3001 });
  } catch {
    await db.destroy();
    throw new Error('OWNER_STARTUP_FAILED');
  }
}
void main().catch(() => {
  console.error('OWNER_STARTUP_FAILED');
  process.exitCode = 1;
});
