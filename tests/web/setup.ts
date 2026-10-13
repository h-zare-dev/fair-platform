import { readFileSync } from 'node:fs';
import { Network, GenericContainer, Wait } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresOwnerAuth } from '../../apps/api/dist/owner/infrastructure/auth-store.js';
import { passwords } from '../../apps/api/dist/owner/infrastructure/password.js';
import { seedSynthetic } from '../../apps/api/dist/owner/infrastructure/seed.js';
export default async function setup() {
  const network = await new Network().start();
  const postgres = await new PostgreSqlContainer(
    process.env.UI_POSTGRES_IMAGE ?? 'fair-fp003b-postgres:test',
  )
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .start();
  const db = createOwnerDataSource(postgres.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  await new PostgresOwnerAuth(db).bootstrap(
    await passwords.hash('synthetic-browser-test-password'),
  );
  await seedSynthetic(db, '11'.repeat(32));
  await db.destroy();
  const internal = `postgresql://${postgres.getUsername()}:${postgres.getPassword()}@postgres:5432/${postgres.getDatabase()}`;
  const api = await new GenericContainer(
    process.env.UI_API_IMAGE ?? 'fair-fp003b-api:test',
  )
    .withNetwork(network)
    .withNetworkAliases('owner-api')
    .withEnvironment({
      DATABASE_URL: internal,
      OWNER_ORIGIN: 'https://panel.fairisfair.ir',
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
  const web = await new GenericContainer(
    process.env.UI_WEB_IMAGE ?? 'fair-fp003b-web:test',
  )
    .withNetwork(network)
    .withNetworkAliases('web')
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
  // Local Caddy uses an internal CA; no real ACME, DNS or staging connection.
  const config = readFileSync('docker/staging/Caddyfile', 'utf8').replace(
    /tls \{\s*issuer acme \{\s*disable_http_challenge\s*\}\s*\}/,
    'tls internal',
  );
  const caddy = await new GenericContainer(
    process.env.UI_CADDY_IMAGE ?? 'fair-fp003b-caddy:test',
  )
    .withNetwork(network)
    .withEnvironment({ ACME_EMAIL: 'operator@example.invalid' })
    .withCopyContentToContainer([
      { content: config, target: '/etc/caddy/Caddyfile' },
    ])
    .withExposedPorts({ container: 443, host: 443 })
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  process.env.UI_DATABASE_URL = postgres.getConnectionUri();
  process.env.UI_API_CONTAINER = api.getId();
  process.env.UI_CADDY_CONTAINER = caddy.getId();

  return async () => {
    await caddy.stop();
    await web.stop();
    await api.stop();
    await postgres.stop();
    await network.stop();
  };
}
