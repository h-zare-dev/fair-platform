import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  BatchProcessor,
  PayloadEncryption,
  createDataSource,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';
import { IngestionLoop } from './modules/pasarguard-ingestion/loop.js';

@Module({})
class WorkerModule {}
async function bootstrap(): Promise<void> {
  const config = readConfig();
  const database = createDataSource(config.DATABASE_URL);
  await database.initialize();
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });
  const logger = new Logger('PasarguardIngestion');
  const loop = new IngestionLoop(
    new BatchProcessor(
      database,
      new PayloadEncryption(config.APP_ENCRYPTION_KEY),
      config.WEBHOOK_NORMALIZATION_MAX_ATTEMPTS,
    ),
    config.WEBHOOK_WORKER_POLL_INTERVAL_MS,
    () => logger.error('BATCH_PROCESSING_FAILED'),
  );
  loop.start();
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await loop.stop();
    await database.destroy();
    await app.close();
  };
  process.once(
    'SIGINT',
    () =>
      void shutdown().catch(() => {
        console.error('WORKER_SHUTDOWN_FAILED');
        process.exitCode = 1;
      }),
  );
  process.once(
    'SIGTERM',
    () =>
      void shutdown().catch(() => {
        console.error('WORKER_SHUTDOWN_FAILED');
        process.exitCode = 1;
      }),
  );
}
void bootstrap().catch(() => {
  console.error('WORKER_STARTUP_FAILED');
  process.exitCode = 1;
});
