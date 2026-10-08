import 'reflect-metadata';
import type { ArgumentsHost } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Controller, Get, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  DurableInbox,
  PayloadEncryption,
  type IngestionConfig,
} from '@fair-platform/pasarguard/infrastructure';
import type { DataSource } from 'typeorm';
import { WebhookController } from './modules/webhooks/controller.js';
import { ReceiveWebhook } from './modules/webhooks/application/receive-webhook.js';
import type { WebhookAuthenticator } from './modules/webhooks/application/authenticator.js';

export async function createApi(
  database: DataSource,
  config: IngestionConfig,
  authenticator: WebhookAuthenticator,
): Promise<NestFastifyApplication> {
  const receiver = new ReceiveWebhook(
    authenticator,
    new DurableInbox(
      database,
      new PayloadEncryption(config.APP_ENCRYPTION_KEY),
      config,
    ),
  );
  @Controller('health')
  class HealthController {
    @Get('live') live(): { ok: true } {
      return { ok: true };
    }
    @Get('ready') async ready(): Promise<{ ok: true }> {
      try {
        await database.query('SELECT 1');
      } catch {
        throw new HttpException('Database unavailable', 503);
      }
      return { ok: true };
    }
  }
  @Module({
    controllers: [WebhookController, HealthController],
    providers: [{ provide: ReceiveWebhook, useValue: receiver }],
  })
  class AppModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );
  // Transport errors, including JSON parser errors, must never reflect source payload fragments.
  app.useGlobalFilters({
    catch(exception: unknown, host: ArgumentsHost): void {
      const status =
        exception instanceof HttpException ? exception.getStatus() : 500;
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      void reply
        .code(status)
        .send({ statusCode: status, message: 'Request failed' });
    },
  });
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
