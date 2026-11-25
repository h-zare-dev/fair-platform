import { createDataSource } from '@fair-platform/pasarguard/infrastructure';
import { OwnerGlobalTimeIndexes1791100000000 } from './query-indexes.js';
import { OwnerDashboard1791000000000 } from './migration.js';
import { PricingEngine1791200000000 } from './pricing-migration.js';
import { AtomicCatalog1791300000000 } from './catalog-migration.js';
import { OwnerSafeGroupDelete1791400000000 } from './group-delete-migration.js';
import { FairShadowCreate1791600000000 } from './shadow-migration.js';
import { OpeningBaseline1791700000000 } from './opening-baseline-migration.js';
import { OpeningBaselineControl1791800000000 } from './opening-baseline-control-migration.js';
import { ReplayShadowJournal1791900000000 } from './replay-shadow-journal-migration.js';
import { ReplayShadowAudit1792000000000 } from './replay-shadow-audit-migration.js';
import { PrivateReplayIdentity1792100000000 } from './private-replay-identity-migration.js';
import { OwnerPasswordChange1792200000000 } from './password-change-migration.js';

import { ReplayArchive1792300000000 } from './replay-archive-migration.js';

export function createOwnerDataSource(url: string) {
  const database = createDataSource(url);
  database.setOptions({
    migrations: [
      ...Object.values(database.options.migrations ?? {}),
      OwnerDashboard1791000000000,
      OwnerGlobalTimeIndexes1791100000000,
      PricingEngine1791200000000,
      AtomicCatalog1791300000000,
      OwnerSafeGroupDelete1791400000000,
      FairShadowCreate1791600000000,
      OpeningBaseline1791700000000,
      OpeningBaselineControl1791800000000,
      ReplayShadowJournal1791900000000,
      ReplayShadowAudit1792000000000,
      PrivateReplayIdentity1792100000000,
      OwnerPasswordChange1792200000000,
      ReplayArchive1792300000000,
    ],
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 5000 },
  });
  return database;
}
