import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  actions,
  canonicalJson,
  children,
  fingerprint,
  normalize,
  sourceTimestamp,
} from '@fair-platform/pasarguard';
import {
  PayloadEncryption,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';
import { ReceiveWebhook } from '../../apps/api/dist/modules/webhooks/application/receive-webhook.js';
import {
  DenyWebhookAuthenticator,
  DevelopmentWebhookAuthenticator,
} from '../../apps/api/dist/modules/webhooks/application/authenticator.js';
import { IngestionLoop } from '../../apps/worker/dist/modules/pasarguard-ingestion/loop.js';
import {
  fixture,
  nulBearingEvent,
  projectedTextPaths,
} from '../helpers/fixtures.js';

const key = '11'.repeat(32);
describe('approved Pasarguard contract', () => {
  it('reads all four synthetic fixtures and isolates the malformed child', () => {
    for (const name of [
      'single-event',
      'batch-events',
      'reset-update',
      'malformed-event',
    ]) {
      const results = children(fixture(name)).map((child) =>
        normalize(child, 'primary'),
      );
      expect(results.filter((result) => result.event)).toHaveLength(
        name === 'single-event' || name === 'malformed-event' ? 1 : 2,
      );
    }
  });
  it.each(actions)(
    'projects supported action %s without interpreting finance',
    (action) => {
      const result = normalize({ ...fixture(), action }, 'primary');
      expect(result.event?.action).toBe(action);
      expect(result.event?.event_status).toBe('READY_FOR_ACCOUNTING');
    },
  );
  it('sorts nested keys, preserves arrays and distinguishes singleton from batch', () => {
    expect(canonicalJson({ z: [2, 1], a: { z: 1, a: 2 } })).toBe(
      '{"a":{"a":2,"z":1},"z":[2,1]}',
    );
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint(fixture())).not.toBe(fingerprint([fixture()]));
  });
  it.each([
    null,
    [],
    1,
    'bad',
    {},
    { events: [fixture()] },
    { notifications: [fixture()] },
    { data: fixture() },
  ])('rejects unsupported envelopes %#', (payload) => {
    expect(() => children(payload)).toThrow();
  });
  it('accepts arrays with invalid children for asynchronous isolation', () => {
    expect(children([null, fixture()])).toHaveLength(2);
  });
  it('preserves exact positive source fractions and identity below milliseconds', () => {
    const first = normalize(
      { ...fixture(), enqueued_at: 1790000000.123456 },
      'primary',
    );
    const second = normalize(
      { ...fixture(), enqueued_at: 1790000000.123457 },
      'primary',
    );
    expect(first.event?.source_enqueued_at).toBe('2026-09-21T14:13:20.123456Z');
    expect(first.event?.semantic_fingerprint).not.toBe(
      second.event?.semantic_fingerprint,
    );
    expect(sourceTimestamp(1790000000)).toBe('2026-09-21T14:13:20Z');
  });
  it.each([NaN, Infinity, '1790000000', null, 253402300800])(
    'rejects invalid source timestamps %#',
    (enqueued_at) => {
      expect(
        normalize({ ...fixture(), enqueued_at }, 'primary').issues[0]?.code,
      ).toBe('INVALID_SOURCE_TIMESTAMP');
    },
  );
  it('optional send time is absent only when omitted, invalid values create issues', () => {
    const input = fixture();
    delete input.send_at;
    expect(normalize(input, 'primary').event?.source_send_at).toBeNull();
    expect(
      normalize({ ...input, send_at: null }, 'primary').issues[0]?.code,
    ).toBe('INVALID_SOURCE_TIMESTAMP');
  });
  it('does not default missing or unsafe traffic to zero', () => {
    const input = fixture();
    const user = input.user as Record<string, unknown>;
    delete user.data_limit;
    expect(normalize(input, 'primary').event).toBeNull();
    user.data_limit = Number.MAX_SAFE_INTEGER + 1;
    expect(normalize(input, 'primary').event).toBeNull();
  });
  it('flags non-null Next Plan without assuming its shape', () => {
    const input = fixture();
    (input.user as Record<string, unknown>).next_plan = {
      invented: 'synthetic-marker',
    };
    const result = normalize(input, 'primary');
    expect(result.event?.event_status).toBe('NEEDS_REVIEW');
    expect(result.event?.next_plan_data_limit_bytes).toBeNull();
    expect(JSON.stringify(result)).not.toContain('synthetic-marker');
  });
  it('unknown action creates only safe review metadata', () => {
    const result = normalize(
      { ...fixture(), action: 'synthetic-private-marker' },
      'primary',
    );
    expect(result.event).toBeNull();
    expect(result.issues[0]?.code).toBe('UNKNOWN_ACTION');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-marker');
  });
  it('fingerprint excludes transport metadata and includes source identity', () => {
    expect(normalize(fixture(), 'primary').event?.semantic_fingerprint).toBe(
      normalize({ ...fixture(), tries: 10, send_at: 1790000100 }, 'primary')
        .event?.semantic_fingerprint,
    );
    expect(
      normalize(fixture(), 'primary').event?.semantic_fingerprint,
    ).not.toBe(normalize(fixture(), 'other').event?.semantic_fingerprint);
  });
});
describe('security and request boundary', () => {
  it('encrypts with independent nonces, authenticates ciphertext and rejects bad keys', () => {
    const encryption = new PayloadEncryption(key);
    const first = encryption.encrypt(canonicalJson(fixture()));
    expect(first.iv).not.toEqual(
      encryption.encrypt(canonicalJson(fixture())).iv,
    );
    expect(encryption.decrypt(first)).toEqual(fixture());
    first.ciphertext[0] = first.ciphertext[0]! ^ 1;
    expect(() => encryption.decrypt(first)).toThrow();
    expect(() => new PayloadEncryption('')).toThrow();
  });
  it('configuration errors never include secrets', () => {
    expect(() =>
      readConfig({ APP_ENCRYPTION_KEY: 'synthetic-secret-marker' }),
    ).toThrow('INVALID_INGESTION_CONFIGURATION');
    expect(() => new DevelopmentWebhookAuthenticator('production')).toThrow();
  });
  it('auth denies before any durable write and strategy exceptions fail closed', async () => {
    let writes = 0;
    for (const auth of [
      new DenyWebhookAuthenticator(),
      {
        authenticate: () =>
          Promise.reject(new Error('synthetic-private-marker')),
      },
    ]) {
      const receiver = new ReceiveWebhook(auth, {
        receive: () => {
          writes++;
          return Promise.resolve();
        },
      });
      await expect(
        receiver.execute(fixture(), { headers: {} }, new Date()),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(writes).toBe(0);
  });
  it('waits for the durable commit and sanitizes database failures', async () => {
    let commit!: () => void;
    const receiver = new ReceiveWebhook(
      new DevelopmentWebhookAuthenticator('test'),
      {
        receive: () =>
          new Promise<void>((resolve) => {
            commit = resolve;
          }),
      },
    );
    let accepted = false;
    const pending = receiver
      .execute(fixture(), { headers: {} }, new Date())
      .then(() => {
        accepted = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).toBe(false);
    commit();
    await pending;
    expect(accepted).toBe(true);
    const failed = new ReceiveWebhook(
      new DevelopmentWebhookAuthenticator('test'),
      { receive: () => Promise.reject(new Error('synthetic-private-marker')) },
    );
    await expect(
      failed.execute(fixture(), { headers: {} }, new Date()),
    ).rejects.toMatchObject({ status: 503, message: 'WEBHOOK_REQUEST_FAILED' });
  });
  it('shutdown waits for an active processor and cancels its polling delay', async () => {
    let finish!: (value: boolean) => void;
    const loop = new IngestionLoop(
      {
        processNext: () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      },
      60000,
    );
    loop.start();
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(true);
    await stopping;
    expect(stopped).toBe(true);
  });
});

it('production startup fails closed even if the development bypass is requested', () => {
  const result = spawnSync(process.execPath, ['apps/api/dist/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_ENCRYPTION_KEY: key,
      DATABASE_URL: 'postgresql://invalid.invalid/unused',
      PASARGUARD_ALLOW_UNAUTHENTICATED_DEVELOPMENT: 'true',
    },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe('API_STARTUP_FAILED');
});
it('source timestamps preserve negative fractional Unix seconds', () => {
  expect(sourceTimestamp(-0.125)).toBe('1969-12-31T23:59:59.875Z');
});

it.each(projectedTextPaths.map((path) => [path.join('.'), path] as const))(
  'FP001-R1: rejects NUL in projected source field %s with a sanitized child issue',
  (_name, path) => {
    const result = normalize(nulBearingEvent(path), 'primary');
    expect(result.event).toBeNull();
    expect(result.issues).toEqual([
      {
        code: 'INVALID_EVENT',
        message: 'Child event failed the approved field contract',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  },
);
it('FP001-R1: rejects NUL in the configured source identity before persistence', () => {
  expect(() =>
    readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused',
      APP_ENCRYPTION_KEY: key,
      PASARGUARD_SOURCE_INSTANCE_ID: 'synthetic-private\u0000marker',
    }),
  ).toThrow('INVALID_INGESTION_CONFIGURATION');
});

it.each([
  [-1e-21, '1970-01-01T00:00:00Z'],
  [-Number.MIN_VALUE, '1970-01-01T00:00:00Z'],
  [0, '1970-01-01T00:00:00Z'],
  [-0, '1970-01-01T00:00:00Z'],
  [1e-21, '1970-01-01T00:00:00Z'],
  [Number.MIN_VALUE, '1970-01-01T00:00:00Z'],
  [-0.125, '1969-12-31T23:59:59.875Z'],
  [-1e-7, '1970-01-01T00:00:00Z'],
  [1e-7, '1970-01-01T00:00:00Z'],
  [-1.000001, '1969-12-31T23:59:58.999999Z'],
  [1.000001, '1970-01-01T00:00:01.000001Z'],
  [-0.0000005, '1970-01-01T00:00:00Z'],
  [0.0000005, '1970-01-01T00:00:00Z'],
  [-0.0000015, '1969-12-31T23:59:59.999998Z'],
  [0.0000015, '1970-01-01T00:00:00.000002Z'],
] as const)(
  'FP001-R2: converts source seconds %s at microsecond precision across the epoch boundary',
  (seconds, expected) => {
    expect(sourceTimestamp(seconds)).toBe(expected);
  },
);
it('FP001-R2: timestamp storage precision does not change numeric fingerprint identity', () => {
  const results = [-1e-21, -Number.MIN_VALUE, 0, 1e-21, Number.MIN_VALUE].map(
    (enqueued_at) =>
      normalize({ ...fixture(), enqueued_at }, 'primary').event
        ?.semantic_fingerprint,
  );
  expect(results.every(Boolean)).toBe(true);
  expect(new Set(results).size).toBe(results.length);
});
