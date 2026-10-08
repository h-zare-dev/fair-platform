import { envelopeSchema } from '@fair-platform/pasarguard';
import type {
  WebhookAuthenticator,
  WebhookRequestMetadata,
} from './authenticator.js';

export interface BatchInbox {
  receive(payload: unknown, receivedAt: Date): Promise<void>;
}
export class WebhookFailure extends Error {
  constructor(public readonly status: 400 | 401 | 503) {
    super('WEBHOOK_REQUEST_FAILED');
  }
}
export class ReceiveWebhook {
  constructor(
    private readonly authenticator: WebhookAuthenticator,
    private readonly inbox: BatchInbox,
  ) {}
  async execute(
    payload: unknown,
    metadata: WebhookRequestMetadata,
    receivedAt: Date,
  ): Promise<void> {
    let authenticated = false;
    try {
      authenticated = await this.authenticator.authenticate(metadata);
    } catch {
      /* Fail closed without exposing strategy errors. */
    }
    if (!authenticated) throw new WebhookFailure(401);
    if (!envelopeSchema.safeParse(payload).success)
      throw new WebhookFailure(400);
    try {
      await this.inbox.receive(payload, receivedAt);
    } catch {
      throw new WebhookFailure(503);
    }
  }
}
