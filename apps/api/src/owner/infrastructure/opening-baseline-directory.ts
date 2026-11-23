import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export class OpeningBaselineUnavailable extends Error {
  constructor() {
    super('OPENING_BASELINE_SOURCE_UNAVAILABLE');
  }
}

const sourceId = z.number().int().safe().positive();
const optionalDate = z
  .union([z.iso.datetime({ offset: true }), z.literal(0), z.null()])
  .optional();
const upstreamSimple = z.object({
  users: z.array(z.object({ id: sourceId })).max(100),
  total: z.number().int().safe().nonnegative().max(1_000_000),
});
const upstreamUser = z.object({
  id: sourceId,
  admin: z
    .object({ id: z.number().int().safe().nonnegative().nullable() })
    .nullable(),
  status: z.enum(['active', 'disabled', 'on_hold', 'expired', 'limited']),
  data_limit: z.number().int().safe().nonnegative().nullable(),
  used_traffic: z.number().int().safe().nonnegative(),
  expire: optionalDate,
  on_hold_expire_duration: z
    .number()
    .int()
    .safe()
    .nonnegative()
    .nullable()
    .optional(),
  data_limit_reset_strategy: z.string().min(1).max(40).nullable().optional(),
  created_at: z.iso.datetime({ offset: true }),
  edit_at: optionalDate,
});
const upstreamDetails = z.object({
  users: z.array(upstreamUser).max(100),
  total: z.number().int().safe().nonnegative().max(1_000_000),
});

export type OpeningUser = {
  externalUserId: string;
  billingAdminId: string | null;
  status: string;
  dataLimitBytes: string | null;
  usedTrafficBytes: string;
  expiresAt: string | null;
  onHoldDurationSeconds: number | null;
  resetStrategy: string | null;
  sourceCreatedAt: string;
  sourceEditedAt: string | null;
  fingerprint: string;
};
export type OpeningPage = { ids: string[]; total: number };
export interface OpeningBaselineDirectory {
  listIds(offset: number, limit: number): Promise<OpeningPage>;
  details(ids: string[]): Promise<OpeningUser[]>;
}

// Only the projection used for the opening state crosses the integration boundary.
// Never persist proxy_settings, subscription_url, notes or any upstream credentials.
function project(user: z.infer<typeof upstreamUser>): OpeningUser {
  const value = {
    externalUserId: String(user.id),
    billingAdminId: user.admin?.id == null ? null : String(user.admin.id),
    status: user.status,
    dataLimitBytes: user.data_limit == null ? null : String(user.data_limit),
    usedTrafficBytes: String(user.used_traffic),
    expiresAt:
      typeof user.expire === 'string'
        ? new Date(user.expire).toISOString()
        : null,
    onHoldDurationSeconds: user.on_hold_expire_duration ?? null,
    resetStrategy: user.data_limit_reset_strategy ?? null,
    sourceCreatedAt: new Date(user.created_at).toISOString(),
    sourceEditedAt:
      typeof user.edit_at === 'string'
        ? new Date(user.edit_at).toISOString()
        : null,
  };
  return {
    ...value,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex'),
  };
}

export class PasarguardOpeningBaselineDirectory implements OpeningBaselineDirectory {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly keyFile: string,
    private readonly http: typeof fetch = fetch,
    private readonly readKey: (
      path: string,
      encoding: 'utf8',
    ) => Promise<string> = readFile,
  ) {
    const base = new URL(baseUrl);
    if (
      base.protocol !== 'https:' ||
      !base.hostname ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash ||
      base.port
    )
      throw new Error('INVALID_OPENING_BASELINE_SOURCE');
    this.base = base;
  }

  private async get(path: string, params: URLSearchParams): Promise<unknown> {
    try {
      const key = (await this.readKey(this.keyFile, 'utf8')).trim();
      if (!key || key.length > 512 || /[\r\n\x00-\x1f\x7f]/.test(key))
        throw new OpeningBaselineUnavailable();
      const url = new URL(path, this.base);
      url.search = params.toString();
      const res = await this.http(url, {
        method: 'GET',
        headers: { 'X-Api-Key': key, Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok || !res.body) throw new OpeningBaselineUnavailable();
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) {
            await reader.cancel();
            throw new OpeningBaselineUnavailable();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      // Never expose host details, source responses or credentials to callers/logs.
      throw new OpeningBaselineUnavailable();
    }
  }

  async listIds(offset: number, limit: number): Promise<OpeningPage> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new OpeningBaselineUnavailable();
    try {
      // The full /api/users list cannot sort by ID; the official simple endpoint can.
      const params = new URLSearchParams({
        sort: 'id',
        offset: String(offset),
        limit: String(limit),
      });
      const data = upstreamSimple.parse(
        await this.get('/api/users/simple', params),
      );
      const ids = data.users.map((user) => String(user.id));
      if (
        ids.length > limit ||
        new Set(ids).size !== ids.length ||
        ids.some((id, i) => i > 0 && BigInt(ids[i - 1]!) >= BigInt(id))
      )
        throw new OpeningBaselineUnavailable();
      return { ids, total: data.total };
    } catch {
      throw new OpeningBaselineUnavailable();
    }
  }

  async details(ids: string[]): Promise<OpeningUser[]> {
    if (
      !ids.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) =>
          !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)),
      )
    )
      throw new OpeningBaselineUnavailable();
    try {
      const params = new URLSearchParams({ limit: String(ids.length) });
      for (const id of ids) params.append('ids', id);
      const data = upstreamDetails.parse(await this.get('/api/users', params));
      const users = data.users.map(project);
      if (
        data.total !== ids.length ||
        users.length !== ids.length ||
        new Set(users.map((user) => user.externalUserId)).size !== ids.length ||
        users.some((user) => !ids.includes(user.externalUserId))
      )
        throw new OpeningBaselineUnavailable();
      return users;
    } catch {
      throw new OpeningBaselineUnavailable();
    }
  }
}
