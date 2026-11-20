import { z } from 'zod';
import { createOwnerDataSource } from './infrastructure/database.js';
import { PostgresOwnerAuth } from './infrastructure/auth-store.js';
import { PostgresOwnerOperations } from './infrastructure/operations.js';
import { passwords } from './infrastructure/password.js';
import { OwnerAuth } from './application/auth.js';
import { createOwnerApi } from './app.js';
import { PostgresPricingStore } from './infrastructure/pricing-store.js';
import { PostgresCatalogStore } from './infrastructure/catalog-store.js';
import { PasarguardAdminDirectory } from './infrastructure/admin-directory.js';
async function main() {
  const config = z
    .object({
      DATABASE_URL: z.string().min(1),
      OWNER_ORIGIN: z.literal('https://panel.fairisfair.ir'),
      FAIR_TIME_ZONE: z.string().default('Asia/Tehran'),
      PASARGUARD_BASE_URL: z.string().optional(),
      PASARGUARD_API_KEY_FILE: z.string().optional(),
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
      new PostgresPricingStore(db),
      new PostgresCatalogStore(db, config.FAIR_TIME_ZONE),
      config.PASARGUARD_BASE_URL && config.PASARGUARD_API_KEY_FILE
        ? new PasarguardAdminDirectory(
            config.PASARGUARD_BASE_URL,
            config.PASARGUARD_API_KEY_FILE,
          )
        : undefined,
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
