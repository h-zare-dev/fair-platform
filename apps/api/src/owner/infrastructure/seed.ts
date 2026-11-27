import type { DataSource } from 'typeorm';
import {
  DurableInbox,
  BatchProcessor,
  PayloadEncryption,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';

/** Stable seed anchor survives partial failure; inbox/event dedup makes reruns idempotent. */
export async function seedSynthetic(
  db: DataSource,
  encryptionKey: string,
): Promise<void> {
  const foreign: { present: boolean }[] = await db.query(
    "SELECT EXISTS(SELECT 1 FROM pasarguard_webhook_batches WHERE source_instance_id <> 'synthetic-fp003b') AS present",
  );
  if (foreign[0]?.present) throw new Error('SYNTHETIC_DATABASE_REQUIRED');
  const config = readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'synthetic-only',
    APP_ENCRYPTION_KEY: encryptionKey,
    PASARGUARD_SOURCE_INSTANCE_ID: 'synthetic-fp003b',
  });
  const rows: { created_at: Date }[] = await db.query(
    `INSERT INTO fair_synthetic_seed (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id=1 RETURNING created_at`,
  );
  const anchor = rows[0]!.created_at;
  const inbox = new DurableInbox(
    db,
    new PayloadEncryption(encryptionKey),
    config,
  );
  for (let n = 0; n < 12; n++) {
    const time = anchor.getTime() / 1000 - n * 300;
    const payload = {
      action: n === 10 ? 'synthetic_unknown_action' : 'user_updated',
      enqueued_at: time,
      send_at: time,
      username: `synthetic-user-${n}`,
      user: {
        id: 1000 + n,
        username: `synthetic-user-${n}`,
        status: 'active',
        data_limit: 10737418240,
        used_traffic: 0,
        lifetime_used_traffic: 0,
        admin: { id: 9001, username: 'synthetic-admin' },
        next_plan: null,
      },
      by: n % 2 ? null : { id: 9002, username: 'synthetic-actor' },
    };
    await inbox.receive(
      n === 11 ? [{ invalid: true }, payload] : payload,
      anchor,
    );
  }
  const processor = new BatchProcessor(
    db,
    new PayloadEncryption(encryptionKey),
    5,
  );
  while (await processor.processNext()) {
    /* Explicit demo operation; no financial processor is called. */
  }
}
