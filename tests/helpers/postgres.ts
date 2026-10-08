import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createDataSource,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer('postgres:17-alpine').start();
}
export function configFor(url: string, retention = 14) {
  return readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    APP_ENCRYPTION_KEY: '11'.repeat(32),
    RAW_WEBHOOK_RETENTION_DAYS: String(retention),
  });
}
export async function migratedDatabase(url: string) {
  const database = createDataSource(url);
  await database.initialize();
  await database.runMigrations({ transaction: 'all' });
  return database;
}
