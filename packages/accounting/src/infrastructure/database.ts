import { DataSource } from 'typeorm';
import { ExceptionEntity, LinkEntity, TransactionEntity } from './entities.js';
import { AccountingFoundations1791000000000 } from './migration.js';
export function createAccountingDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    logging: false,
    entities: [TransactionEntity, LinkEntity, ExceptionEntity],
    migrations: [AccountingFoundations1791000000000],
    migrationsTableName: 'accounting_migrations',
    migrationsRun: false,
  });
}
