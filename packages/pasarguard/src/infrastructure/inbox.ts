import type { DataSource } from 'typeorm';
import { canonicalJson, fingerprint } from '../fingerprinting/canonical.js';
import { children } from '../schemas/envelope.js';
import type { IngestionConfig } from './config.js';
import { PayloadEncryption } from './encryption.js';
import { BatchEntity } from './entities.js';

export class DurableInbox {
  constructor(
    private readonly database: DataSource,
    private readonly encryption: PayloadEncryption,
    private readonly config: IngestionConfig,
  ) {}

  async receive(payload: unknown, receivedAt = new Date()): Promise<void> {
    const eventCount = children(payload).length;
    const encrypted = this.encryption.encrypt(canonicalJson(payload));
    const expires = new Date(
      receivedAt.getTime() + this.config.RAW_WEBHOOK_RETENTION_DAYS * 86400000,
    );
    await this.database.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(BatchEntity)
        .values({
          source_instance_id: this.config.PASARGUARD_SOURCE_INSTANCE_ID,
          received_at: receivedAt,
          payload_hash: fingerprint(payload),
          event_count: eventCount,
          processing_status: 'RECEIVED',
          processing_attempts: 0,
          raw_payload_ciphertext: encrypted.ciphertext,
          raw_payload_iv: encrypted.iv,
          raw_payload_auth_tag: encrypted.authTag,
          raw_payload_key_version: encrypted.keyVersion,
          raw_payload_expires_at: expires,
        })
        .orIgnore()
        .execute();
    });
  }
}
