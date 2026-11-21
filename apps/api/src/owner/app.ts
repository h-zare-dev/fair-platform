import 'reflect-metadata';
import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Module,
  HttpException,
  HttpCode,
  type ArgumentsHost,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DurableInbox } from '@fair-platform/pasarguard/infrastructure';
import { z } from 'zod';
import { PricingError } from '@fair-platform/pricing';
import {
  DirectoryUnavailable,
  type AdminDirectory,
} from './infrastructure/admin-directory.js';
import type { PricingReader } from './infrastructure/pricing-store.js';
import {
  CatalogError,
  type PostgresCatalogStore,
} from './infrastructure/catalog-store.js';
import type { OwnerAuth } from './application/auth.js';
import type { PostgresShadowReader } from './infrastructure/shadow-reader.js';
import {
  ReceiveWebhook,
  WebhookFailure,
} from '../modules/webhooks/application/receive-webhook.js';
import {
  OwnerOperations,
  type OperationsReader,
} from './application/operations.js';
export const COOKIE = '__Host-fair_owner';
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const positive = z.string().regex(/^[1-9][0-9]{0,18}$/);
const source = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
const stamp = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/);
const window = { effectiveFrom: stamp, effectiveUntil: stamp.nullable() };
const plan = z
  .object({ sourceInstanceId: source, name: z.string().trim().min(1).max(100) })
  .strict();
const version = z
  .object({
    sourceInstanceId: source,
    planId: positive.optional(),
    billingAdminId: decimal.optional(),
    mode: z.enum(['PER_GIB', 'FIXED', 'MIXED']),
    rateTomanPerGiB: positive.nullable(),
    fixedPackages: z
      .record(positive, positive)
      .refine((v) => Object.keys(v).length <= 100),
    ...window,
  })
  .strict()
  .refine((v) => (v.planId === undefined) !== (v.billingAdminId === undefined));
const assignment = z
  .object({
    sourceInstanceId: source,
    planId: positive,
    billingAdminId: decimal.nullable(),
    ...window,
  })
  .strict();
const quoteInput = z
  .object({
    sourceInstanceId: source,
    billingAdminId: decimal,
    occurredAt: stamp,
    billableBytes: positive,
    purpose: z.enum(['FULL_PACKAGE', 'POSITIVE_DELTA']),
    unlimited: z.boolean().optional(),
  })
  .strict();
const catalogPackage = z
  .object({
    sourceInstanceId: source,
    name: z.string().min(1).max(100),
    packageBytes: positive,
    durationDays: z.number().int().min(1).max(36500),
    amountToman: positive,
  })
  .strict();
const catalogMembership = z
  .object({
    sourceInstanceId: source,
    billingAdminId: decimal,
    groupId: positive.nullable(),
  })
  .strict();
const directoryQuery = z
  .object({
    search: z
      .string()
      .max(64)
      .regex(/^[^\x00-\x1f\x7f]*$/)
      .transform((v) => v.trim())
      .default(''),
    offset: z
      .string()
      .regex(/^(0|[1-9]\d{0,4})$/)
      .transform(Number)
      .default(0),
    limit: z
      .string()
      .regex(/^[1-9]\d?$/)
      .transform(Number)
      .refine((v) => v <= 50)
      .default(25),
  })
  .strict();
const catalogAssignment = z
  .object({
    sourceInstanceId: source,
    targetKind: z.enum(['GROUP', 'ADMIN']),
    targetId: decimal,
    packageId: positive.optional(),
    rateTomanPerGiB: positive.optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .strict();
const shadowQuery = z
  .object({
    source: source.optional(),
    admin: decimal.optional(),
    reason: z
      .enum([
        'MISSING_DURATION',
        'PRICING_MISSING',
        'UNEXPECTED_UNLIMITED',
        'AMBIGUOUS_CORRELATION',
        'AMBIGUOUS_CORRECTION',
        'PRICING_CONFIG_CONFLICT',
        'LATE_EVENT_AFTER_CLOSE',
      ])
      .optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
// One exact Owner-supplied legacy export; never a second live webhook source.
const REPLAY_SHA256 =
  'fa845d0a2276e65ff7ca4c77fc253c289309541ed3367d752ab3ee4af190e242';
const replayRecords = z
  .object({
    records: z
      .array(
        z
          .object({
            receivedAt: z.string().datetime({ offset: true }),
            payload: z
              .array(z.record(z.string(), z.unknown()))
              .min(1)
              .max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
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
  pricing?: PricingReader,
  catalog?: PostgresCatalogStore,
  directory?: AdminDirectory,
  shadow?: PostgresShadowReader,
  webhook?: ReceiveWebhook,
  replayInbox?: DurableInbox,
): Promise<NestFastifyApplication> {
  const operations = new OwnerOperations(reader);
  async function requireOwner(req: FastifyRequest) {
    if (!(await auth.authenticated(sessionToken(req.headers.cookie))))
      throw new HttpException('Unauthorized', 401);
  }
  function input<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new HttpException('Invalid request', 400);
    return parsed.data;
  }
  async function priceWrite<T>(
    req: FastifyRequest,
    schema: z.ZodType<T>,
    fn: (v: T) => Promise<unknown>,
  ) {
    csrf(req);
    await requireOwner(req);
    if (!pricing) throw new HttpException('Unavailable', 503);
    try {
      return await fn(input(schema, req.body));
    } catch (e) {
      if (e instanceof PricingError)
        throw new HttpException(
          e.code,
          e.code === 'PRICING_MISSING' ? 422 : 400,
        );
      if (e instanceof CatalogError)
        throw new HttpException(
          e.code,
          e.code === 'CATALOG_NOT_FOUND' ? 404 : 409,
        );
      if (e instanceof RangeError)
        throw new HttpException('Invalid calendar date or timezone', 400);
      if (e instanceof Error && e.message === 'ASSIGNMENT_CLOSED_PERIOD')
        throw new HttpException('ASSIGNMENT_CLOSED_PERIOD', 409);
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        ['23P01', '23505', '23503', '23514', '22003'].includes(String(e.code))
      )
        throw new HttpException('Pricing conflict or invalid reference', 409);
      throw e;
    }
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
        mode: 'STAGING / AUTHENTICATED SHADOW TEST / NO LIVE BILLING',
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
    @Get('operations/accounting/summary') async accountingSummary(
      @Req() req: FastifyRequest,
    ) {
      await requireOwner(req);
      if (!shadow) throw new HttpException('Unavailable', 503);
      const q = input(
        z.object({ source: source.optional() }).strict(),
        req.query,
      );
      return shadow.summary(q.source ?? null);
    }
    @Get('operations/accounting/replay-preview') async accountingReplayPreview(
      @Req() req: FastifyRequest,
    ) {
      await requireOwner(req);
      if (!shadow) throw new HttpException('Unavailable', 503);
      input(z.object({}).strict(), req.query);
      return shadow.replayPreview();
    }
    @Get('operations/accounting/ambiguities') async accountingAmbiguities(
      @Req() req: FastifyRequest,
    ) {
      await requireOwner(req);
      if (!shadow) throw new HttpException('Unavailable', 503);
      const q = input(shadowQuery, req.query);
      return shadow.ambiguities({
        source: q.source ?? null,
        admin: q.admin ?? null,
        reason: q.reason ?? null,
        date: q.date ?? null,
        limit: q.limit,
        offset: q.offset,
      });
    }
    @Get('directory/admins') async directoryAdmins(@Req() req: FastifyRequest) {
      await requireOwner(req);
      const query = input(directoryQuery, req.query);
      if (!directory) throw new HttpException('DIRECTORY_UNAVAILABLE', 503);
      try {
        return await directory.list(query);
      } catch (error) {
        if (error instanceof DirectoryUnavailable)
          throw new HttpException('DIRECTORY_UNAVAILABLE', 503);
        throw error;
      }
    }
    @Get('pricing/config') async pricingConfig(@Req() req: FastifyRequest) {
      await requireOwner(req);
      if (!pricing) throw new HttpException('Unavailable', 503);
      const q = input(z.object({ source: source }).strict(), req.query);
      return pricing.list(q.source);
    }
    @Post('pricing/plans') pricingPlan(@Req() req: FastifyRequest) {
      return priceWrite(req, plan, (v) => pricing!.createPlan(v));
    }
    @Post('pricing/versions') pricingVersion(@Req() req: FastifyRequest) {
      return priceWrite(req, version, (v) => pricing!.createVersion(v));
    }
    @Post('pricing/assignments') pricingAssignment(@Req() req: FastifyRequest) {
      return priceWrite(req, assignment, (v) => pricing!.assign(v));
    }
    @Post('pricing/quote')
    @HttpCode(200)
    pricingQuote(@Req() req: FastifyRequest) {
      return priceWrite(req, quoteInput, (v) => pricing!.quote(v));
    }
    @Get('catalog/config') async catalogConfig(@Req() req: FastifyRequest) {
      await requireOwner(req);
      if (!catalog) throw new HttpException('Unavailable', 503);
      const q = input(z.object({ source }).strict(), req.query);
      return catalog.list(q.source);
    }
    @Post('catalog/groups') catalogGroup(@Req() req: FastifyRequest) {
      return priceWrite(
        req,
        z
          .object({
            sourceInstanceId: source,
            name: z.string().trim().min(1).max(100),
          })
          .strict(),
        (v) => catalog!.createGroup(v),
      );
    }
    @Post('catalog/groups/delete') catalogDeleteGroup(
      @Req() req: FastifyRequest,
    ) {
      return priceWrite(
        req,
        z.object({ sourceInstanceId: source, groupId: positive }).strict(),
        (v) => catalog!.deleteGroup(v),
      );
    }
    @Post('catalog/memberships') catalogMembership(@Req() req: FastifyRequest) {
      return priceWrite(req, catalogMembership, (v) =>
        catalog!.changeMembership(v),
      );
    }
    @Post('catalog/packages') catalogCreatePackage(@Req() req: FastifyRequest) {
      return priceWrite(req, catalogPackage, (v) => catalog!.createPackage(v));
    }
    @Post('catalog/packages/edit') catalogEditPackage(
      @Req() req: FastifyRequest,
    ) {
      return priceWrite(
        req,
        catalogPackage.extend({ packageId: positive }),
        (v) => catalog!.editPackage(v),
      );
    }
    @Post('catalog/packages/copy') catalogCopyPackage(
      @Req() req: FastifyRequest,
    ) {
      return priceWrite(
        req,
        z
          .object({
            sourceInstanceId: source,
            packageId: positive,
            name: z.string().trim().min(1).max(100),
            amountToman: positive,
          })
          .strict(),
        (v) => catalog!.copyPackage(v),
      );
    }
    @Post('catalog/assignments') catalogAssign(@Req() req: FastifyRequest) {
      return priceWrite(req, catalogAssignment, (v) => catalog!.assign(v));
    }
    @Post('catalog/assignments/end') catalogChangeEnd(
      @Req() req: FastifyRequest,
    ) {
      return priceWrite(
        req,
        z
          .object({
            sourceInstanceId: source,
            assignmentId: positive,
            endDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullable(),
          })
          .strict(),
        (v) => catalog!.changeEnd(v),
      );
    }
  }
  @Controller('api/v1/owner/webhook')
  class ShadowWebhookController {
    @Post('pasarguard')
    @HttpCode(202)
    async accept(@Req() req: FastifyRequest) {
      if (req.headers['x-fair-replay-import'] !== undefined) {
        csrf(req);
        await requireOwner(req);
        if (!replayInbox) throw new HttpException('Unavailable', 503);
        if (req.headers['x-fair-replay-import'] !== REPLAY_SHA256)
          throw new HttpException('Replay archive mismatch', 400);
        const data = input(replayRecords, req.body);
        // Validate all timestamps before writing any batch in this request.
        const dates = data.records.map((r) => new Date(r.receivedAt));
        if (
          dates.some(
            (d) =>
              !Number.isFinite(d.getTime()) ||
              d.getTime() < Date.parse('2026-10-21T00:00:00Z') ||
              d.getTime() > Date.parse('2026-11-21T00:00:00Z'),
          )
        )
          throw new HttpException('Replay date outside approved window', 400);
        for (let i = 0; i < data.records.length; i++)
          await replayInbox.receive(data.records[i]!.payload, dates[i]);
        return { accepted: data.records.length };
      }
      // This is NOT an Owner session endpoint: a distinct long random secret
      // authenticates the upstream source. Never permit an unauthenticated bypass.
      if (!webhook) throw new HttpException('Unavailable', 503);
      try {
        await webhook.execute(req.body, { headers: req.headers }, new Date());
      } catch (error) {
        if (error instanceof WebhookFailure)
          throw new HttpException('Webhook rejected', error.status);
        throw error;
      }
      return { accepted: true };
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
  @Module({
    controllers: [OwnerController, ShadowWebhookController, HealthController],
  })
  class OwnerModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    OwnerModule,
    new FastifyAdapter({
      logger: false,
      bodyLimit: 262144,
      trustProxy: false,
      requestTimeout: 10000,
    }),
    { logger: false },
  );
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_req, reply, payload, done) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      done(null, payload);
    });
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
                : e instanceof HttpException &&
                    e.getResponse() === 'DIRECTORY_UNAVAILABLE'
                  ? 'DIRECTORY_UNAVAILABLE'
                  : 'Request failed',
        });
    },
  });
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
