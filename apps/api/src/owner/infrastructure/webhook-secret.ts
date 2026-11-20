import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  WebhookAuthenticator,
  WebhookRequestMetadata,
} from '../../modules/webhooks/application/authenticator.js';

/** PasarGuard's x-webhook-secret shared-secret protocol; fail closed on malformed headers. */
export class PasarguardSecretAuthenticator implements WebhookAuthenticator {
  private readonly expected: Buffer;
  constructor(secret: string) {
    if (secret.length < 32 || secret.length > 512 || /[\r\n\x00]/.test(secret))
      throw new Error('INVALID_WEBHOOK_SECRET');
    this.expected = createHash('sha256').update(secret, 'utf8').digest();
  }
  authenticate(request: WebhookRequestMetadata): Promise<boolean> {
    const header = request.headers['x-webhook-secret'];
    if (typeof header !== 'string' || header.length < 32 || header.length > 512)
      return Promise.resolve(false);
    const actual = createHash('sha256').update(header, 'utf8').digest();
    return Promise.resolve(timingSafeEqual(actual, this.expected));
  }
}
