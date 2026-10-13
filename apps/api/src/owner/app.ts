import 'reflect-metadata';
import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Module,
  HttpException,
  type ArgumentsHost,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { OwnerAuth } from './application/auth.js';
import {
  OwnerOperations,
  type OperationsReader,
} from './application/operations.js';
export const COOKIE = '__Host-fair_owner';
export function sessionToken(cookie: string | undefined): string | null {
  const matches =
    cookie
      ?.split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${COOKIE}=`)) ?? [];
  return matches.length === 1 ? matches[0]!.slice(COOKIE.length + 1) : null;
}
export async function createOwnerApi(
  auth: OwnerAuth,
  reader: OperationsReader,
  origin: string,
): Promise<NestFastifyApplication> {
  const operations = new OwnerOperations(reader);
  async function requireOwner(req: FastifyRequest) {
    if (!(await auth.authenticated(sessionToken(req.headers.cookie))))
      throw new HttpException('Unauthorized', 401);
  }
  // Origin + JSON-only requests + mandatory custom header cannot be forged by a cross-origin HTML form.
  // No CORS is enabled. Never trust client X-Forwarded-* for auth or rate limiting.
  function csrf(req: FastifyRequest) {
    if (
      req.headers.origin !== origin ||
      req.headers['x-fair-csrf'] !== '1' ||
      !req.headers['content-type']?.startsWith('application/json')
    )
      throw new HttpException('Forbidden', 403);
  }
  const cookie = (token: string, maxAge: number) =>
    `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  @Controller('api/v1/owner')
  class OwnerController {
    @Post('auth/login') async login(
      @Req() req: FastifyRequest,
      @Res({ passthrough: true }) reply: FastifyReply,
    ) {
      csrf(req);
      const input = z
        .object({ password: z.string().min(1).max(1024) })
        .strict()
        .safeParse(req.body);
      if (!input.success) throw new HttpException('Invalid request', 400);
      const result = await auth.login(
        input.data.password,
        sessionToken(req.headers.cookie),
      );
      if (result.kind !== 'ok') {
        if (result.kind === 'limited') reply.header('Retry-After', '60');
        throw new HttpException(
          'Invalid credentials',
          result.kind === 'limited' ? 429 : 401,
        );
      }
      reply.header('Set-Cookie', cookie(result.token, 43200));
      return { authenticated: true };
    }
    @Post('auth/logout') async logout(
      @Req() req: FastifyRequest,
      @Res({ passthrough: true }) reply: FastifyReply,
    ) {
      csrf(req);
      await requireOwner(req);
      await auth.logout(sessionToken(req.headers.cookie));
      reply.header('Set-Cookie', cookie('', 0));
      return { authenticated: false };
    }
    @Get('auth/session') async session(@Req() req: FastifyRequest) {
      await requireOwner(req);
      return {
        authenticated: true,
        mode: 'STAGING / SYNTHETIC / SHADOW / NO LIVE BILLING',
      };
    }
    async read(kind: 'summary' | 'events' | 'issues', req: FastifyRequest) {
      await requireOwner(req);
      try {
        return await operations.read(kind, req.query);
      } catch (e) {
        if (
          e instanceof z.ZodError ||
          e instanceof SyntaxError ||
          (e instanceof Error &&
            ['INVALID_FILTER', 'INVALID_CURSOR', 'INVALID_RANGE'].includes(
              e.message,
            ))
        )
          throw new HttpException('Invalid filter', 400);
        throw e;
      }
    }
    @Get('operations/summary') summary(@Req() req: FastifyRequest) {
      return this.read('summary', req);
    }
    @Get('operations/events') events(@Req() req: FastifyRequest) {
      return this.read('events', req);
    }
    @Get('operations/issues') issues(@Req() req: FastifyRequest) {
      return this.read('issues', req);
    }
  }
  @Controller('health')
  class HealthController {
    @Get('live') live() {
      return { ok: true };
    }
    @Get('ready') async ready() {
      try {
        await reader.ready();
        return { ok: true };
      } catch {
        throw new HttpException('Unavailable', 503);
      }
    }
  }
  @Module({ controllers: [OwnerController, HealthController] })
  class OwnerModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    OwnerModule,
    new FastifyAdapter({
      logger: false,
      bodyLimit: 4096,
      trustProxy: false,
      requestTimeout: 10000,
    }),
    { logger: false },
  );
  app
    .getHttpAdapter()
    .getInstance()
    .addHook(
      'onSend',
      (
        _req: FastifyRequest,
        reply: FastifyReply,
        payload: unknown,
        done: (err: Error | null, value: unknown) => void,
      ) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
        done(null, payload);
      },
    );
  app.useGlobalFilters({
    catch(e: unknown, host: ArgumentsHost) {
      const status = e instanceof HttpException ? e.getStatus() : 503;
      void host
        .switchToHttp()
        .getResponse<FastifyReply>()
        .code(status)
        .send({
          statusCode: status,
          message:
            status === 401
              ? 'Invalid credentials or session'
              : status === 429
                ? 'Try again later'
                : 'Request failed',
        });
    },
  });
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
