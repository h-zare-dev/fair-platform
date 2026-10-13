import { createDataSource } from '@fair-platform/pasarguard/infrastructure';
import { OwnerDashboard1791000000000 } from './migration.js';

export function createOwnerDataSource(url: string) {
  const database = createDataSource(url);
  database.setOptions({
    migrations: [
      ...Object.values(database.options.migrations ?? {}),
      OwnerDashboard1791000000000,
    ],
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 5000 },
  });
  return database;
}
