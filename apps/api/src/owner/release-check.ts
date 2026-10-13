import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createOwnerDataSource } from './infrastructure/database.js';
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_REQUIRED');
  const db = createOwnerDataSource(process.env.DATABASE_URL);
  await db.initialize();
  try {
    const migrations: { name: string | null }[] = await db.query(
      "SELECT to_regclass('migrations')::text AS name",
    );
    const rows: { name: string }[] = migrations[0]?.name
      ? await db.query('SELECT name FROM migrations ORDER BY id')
      : [];
    const approved = [
      'PasarguardInbox1790000000000',
      'OwnerDashboard1791000000000',
    ];
    if (rows.some((r) => !approved.includes(r.name)))
      throw new Error('UNKNOWN_SCHEMA');
    const files = [
      'node_modules/@fair-platform/pasarguard/dist/infrastructure/migration.js',
      'dist/owner/infrastructure/migration.js',
    ];
    const hashes: Record<string, string> = {};
    for (const file of files)
      hashes[file] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    console.info(
      JSON.stringify({
        schema: 'fp003b-v1',
        migrations: rows.map((r) => r.name),
        hashes,
      }),
    );
  } finally {
    await db.destroy();
  }
}
void main().catch(() => {
  console.error('SCHEMA_COMPATIBILITY_FAILED');
  process.exitCode = 1;
});
