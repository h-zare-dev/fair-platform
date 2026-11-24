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
      'OwnerGlobalTimeIndexes1791100000000',
      'PricingEngine1791200000000',
      'AtomicCatalog1791300000000',
      'OwnerSafeGroupDelete1791400000000',
      'PasarguardBillingProjection1791500000000',
      'FairShadowCreate1791600000000',
      'OpeningBaseline1791700000000',
      'OpeningBaselineControl1791800000000',
      'ReplayShadowJournal1791900000000',
      'ReplayShadowAudit1792000000000',
      'PrivateReplayIdentity1792100000000',
    ];
    const configuredMigrations = db.migrations
      .map((m) => m.name ?? m.constructor.name)
      .sort();
    if (
      configuredMigrations.length !== approved.length ||
      configuredMigrations.some((name) => !approved.includes(name))
    )
      throw new Error('UNAPPROVED_MIGRATIONS');
    if (rows.some((r) => !approved.includes(r.name)))
      throw new Error('UNKNOWN_SCHEMA');
    const files = [
      'node_modules/@fair-platform/pasarguard/dist/infrastructure/migration.js',
      'dist/owner/infrastructure/migration.js',
      'dist/owner/infrastructure/query-indexes.js',
      'dist/owner/infrastructure/pricing-migration.js',
      'dist/owner/infrastructure/catalog-migration.js',
      'dist/owner/infrastructure/group-delete-migration.js',
      'node_modules/@fair-platform/pasarguard/dist/infrastructure/billing-projection-migration.js',
      'dist/owner/infrastructure/shadow-migration.js',
      'dist/owner/infrastructure/opening-baseline-migration.js',
      'dist/owner/infrastructure/opening-baseline-control-migration.js',
      'dist/owner/infrastructure/replay-shadow-journal-migration.js',
      'dist/owner/infrastructure/replay-shadow-audit-migration.js',
      'dist/owner/infrastructure/private-replay-identity-migration.js',
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
        configuredMigrations,
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
