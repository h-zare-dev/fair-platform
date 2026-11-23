import { z } from 'zod';
import { readFileSync } from 'node:fs';
import {
  BatchProcessor,
  DurableInbox,
  PayloadEncryption,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';
import { ReceiveWebhook } from '../modules/webhooks/application/receive-webhook.js';
import { createOwnerDataSource } from './infrastructure/database.js';
import { PostgresOwnerAuth } from './infrastructure/auth-store.js';
import { PostgresOwnerOperations } from './infrastructure/operations.js';
import { passwords } from './infrastructure/password.js';
import { OwnerAuth } from './application/auth.js';
import { createOwnerApi } from './app.js';
import { PostgresPricingStore } from './infrastructure/pricing-store.js';
import { PostgresCatalogStore } from './infrastructure/catalog-store.js';
import { PasarguardAdminDirectory } from './infrastructure/admin-directory.js';
import { PasarguardSecretAuthenticator } from './infrastructure/webhook-secret.js';
import { PostgresShadowReader } from './infrastructure/shadow-reader.js';
import { NightlyShadow } from './infrastructure/nightly-shadow.js';
async function main() {
  const config = z
    .object({
      DATABASE_URL: z.string().min(1),
      OWNER_ORIGIN: z.literal('https://panel.fairisfair.ir'),
      FAIR_TIME_ZONE: z.string().default('Asia/Tehran'),
      FAIR_CORRELATION_WINDOW_SECONDS: z.coerce
        .number()
        .int()
        .min(1)
        .max(600)
        .default(600),
      PASARGUARD_BASE_URL: z.string().optional(),
      PASARGUARD_API_KEY_FILE: z.string().optional(),
      APP_ENCRYPTION_KEY_FILE: z.string().optional(),
      PASARGUARD_WEBHOOK_SECRET_FILE: z.string().optional(),
      FAIR_SHADOW_ENABLED: z.enum(['true', 'false']).default('false'),
      FAIR_SHADOW_CLOSE_TIME: z.string().default('02:10'),
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
    // Public staging remains fail-closed until both independent secrets exist.
    // Read only mounted secret files: never send keys to browser, logs or Git.
    const ingest =
      config.APP_ENCRYPTION_KEY_FILE && config.PASARGUARD_WEBHOOK_SECRET_FILE
        ? (() => {
            const key = readFileSync(
              config.APP_ENCRYPTION_KEY_FILE,
              'utf8',
            ).trim();
            const secret = readFileSync(
              config.PASARGUARD_WEBHOOK_SECRET_FILE,
              'utf8',
            ).trim();
            const settings = readConfig({
              ...process.env,
              DATABASE_URL: config.DATABASE_URL,
              APP_ENCRYPTION_KEY: key,
              PASARGUARD_SOURCE_INSTANCE_ID: 'primary',
            });
            const encryption = new PayloadEncryption(
              settings.APP_ENCRYPTION_KEY,
            );
            return {
              receiver: new ReceiveWebhook(
                new PasarguardSecretAuthenticator(secret),
                new DurableInbox(db, encryption, settings),
              ),
              // Isolated from primary: the nightly financial SHADOW closer only
              // considers source `primary`, never the private 30-day replay.
              replayInbox:
                config.FAIR_SHADOW_ENABLED === 'true'
                  ? new DurableInbox(db, encryption, {
                      ...settings,
                      PASARGUARD_SOURCE_INSTANCE_ID: 'replay-30d',
                    })
                  : undefined,
              processor: new BatchProcessor(
                db,
                encryption,
                settings.WEBHOOK_NORMALIZATION_MAX_ATTEMPTS,
              ),
            };
          })()
        : null;
    const nightly =
      config.FAIR_SHADOW_ENABLED === 'true'
        ? new NightlyShadow(
            db,
            config.FAIR_TIME_ZONE,
            config.FAIR_SHADOW_CLOSE_TIME,
          )
        : null;
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
      new PostgresShadowReader(
        db,
        config.FAIR_TIME_ZONE,
        config.FAIR_CORRELATION_WINDOW_SECONDS,
      ),
      ingest?.receiver,
      ingest?.replayInbox,
    );
    let processing = false;
    const ingestionLoop = setInterval(() => {
      if (!ingest || processing) return;
      processing = true;
      void (async () => {
        // Bounded backlogs drain without waiting a whole second per batch.
        // This performs normalization only, never a financial calculation.
        for (let i = 0; i < 40; i++)
          if (!(await ingest.processor.processNext())) break;
      })()
        .catch(() => console.error('SHADOW_INGESTION_FAILED'))
        .finally(() => {
          processing = false;
        });
    }, 1000);
    ingestionLoop.unref();
    // Retain only the normalized projection after the encrypted payload's TTL.
    // Never purge an unprocessed batch, even if its nominal TTL has elapsed.
    const rawCleanup = setInterval(() => {
      if (!ingest) return;
      void db
        .query(
          `UPDATE pasarguard_webhook_batches
        SET raw_payload_ciphertext=NULL,raw_payload_iv=NULL,
            raw_payload_auth_tag=NULL,raw_payload_key_version=NULL,
            raw_payload_purged_at=now()
        WHERE raw_payload_expires_at<=now() AND raw_payload_purged_at IS NULL
          AND processing_status IN ('NORMALIZED','FAILED_PERMANENT')`,
        )
        .catch(() => console.error('SHADOW_RAW_CLEANUP_FAILED'));
    }, 3600000);
    rawCleanup.unref();
    let nightlyBusy = false;
    const nightlyLoop = setInterval(() => {
      if (!nightly || nightlyBusy) return;
      nightlyBusy = true;
      void nightly
        .run()
        .catch(() => console.error('SHADOW_NIGHTLY_FAILED'))
        .finally(() => {
          nightlyBusy = false;
        });
    }, 60000);
    nightlyLoop.unref();
    const cleanup = setInterval(() => {
      void store.cleanup().catch(() => console.error('OWNER_CLEANUP_FAILED'));
    }, 60000);
    cleanup.unref();
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onClose', async () => {
        clearInterval(cleanup);
        clearInterval(ingestionLoop);
        clearInterval(rawCleanup);
        clearInterval(nightlyLoop);
        while (processing || nightlyBusy)
          await new Promise((r) => setTimeout(r, 50));
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
