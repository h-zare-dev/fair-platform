import { DataSource } from 'typeorm';
import { BatchEntity, EventEntity, IssueEntity } from './entities.js';
import { PasarguardInbox1790000000000 } from './migration.js';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    logging: false,
    entities: [BatchEntity, EventEntity, IssueEntity],
    migrations: [PasarguardInbox1790000000000],
    migrationsRun: false,
  });
}
