import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}
export class PayloadEncryption {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey))
      throw new Error('INVALID_ENCRYPTION_CONFIGURATION');
    this.key = Buffer.from(hexKey, 'hex');
  }
  encrypt(payload: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return {
      ciphertext: Buffer.concat([
        cipher.update(payload, 'utf8'),
        cipher.final(),
      ]),
      iv,
      authTag: cipher.getAuthTag(),
      keyVersion: 1,
    };
  }
  decrypt(payload: EncryptedPayload): unknown {
    if (payload.keyVersion !== 1)
      throw new Error('UNSUPPORTED_ENCRYPTION_KEY_VERSION');
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.iv);
    decipher.setAuthTag(payload.authTag);
    return JSON.parse(
      Buffer.concat([
        decipher.update(payload.ciphertext),
        decipher.final(),
      ]).toString('utf8'),
    ) as unknown;
  }
}
