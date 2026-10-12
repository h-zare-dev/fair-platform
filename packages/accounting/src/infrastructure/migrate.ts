import 'reflect-metadata';
import { createAccountingDataSource } from './database.js';
async function migrate(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_REQUIRED');
  const source = createAccountingDataSource(url);
  await source.initialize();
  try {
    await source.runMigrations({ transaction: 'all' });
  } finally {
    await source.destroy();
  }
}
void migrate().catch(() => {
  console.error('ACCOUNTING_MIGRATION_FAILED');
  process.exitCode = 1;
});
