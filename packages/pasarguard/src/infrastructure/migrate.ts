import 'reflect-metadata';
import { createDataSource } from './database.js';
import { readConfig } from './config.js';

async function migrate(): Promise<void> {
  const source = createDataSource(readConfig().DATABASE_URL);
  await source.initialize();
  try {
    await source.runMigrations({ transaction: 'all' });
  } finally {
    await source.destroy();
  }
}
void migrate().catch(() => {
  console.error('MIGRATION_FAILED');
  process.exitCode = 1;
});
