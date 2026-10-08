export interface WebhookRequestMetadata {
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
/** No upstream protocol is assumed. Verified strategies implement this application port. */
export interface WebhookAuthenticator {
  authenticate(metadata: WebhookRequestMetadata): Promise<boolean>;
}
export class DenyWebhookAuthenticator implements WebhookAuthenticator {
  authenticate(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
export class DevelopmentWebhookAuthenticator implements WebhookAuthenticator {
  constructor(environment: string) {
    if (environment !== 'development' && environment !== 'test')
      throw new Error('UNSAFE_AUTHENTICATOR_CONFIGURATION');
  }
  authenticate(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
