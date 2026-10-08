import {
  createDataSource,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';
import { createApi } from './app.js';
import {
  DenyWebhookAuthenticator,
  DevelopmentWebhookAuthenticator,
} from './modules/webhooks/application/authenticator.js';

async function bootstrap(): Promise<void> {
  const config = readConfig();
  const developmentBypass =
    process.env.PASARGUARD_ALLOW_UNAUTHENTICATED_DEVELOPMENT === 'true';
  if (config.NODE_ENV === 'production')
    throw new Error('VERIFIED_WEBHOOK_AUTHENTICATOR_REQUIRED');
  const auth = developmentBypass
    ? new DevelopmentWebhookAuthenticator(config.NODE_ENV)
    : new DenyWebhookAuthenticator();
  const database = createDataSource(config.DATABASE_URL);
  await database.initialize();
  try {
    const app = await createApi(database, config, auth);
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onClose', async () => {
        if (database.isInitialized) await database.destroy();
      });
    await app.listen({ host: '0.0.0.0', port: 3001 });
  } catch {
    await database.destroy();
    throw new Error('API_STARTUP_FAILED');
  }
}
void bootstrap().catch(() => {
  console.error('API_STARTUP_FAILED');
  process.exitCode = 1;
});
