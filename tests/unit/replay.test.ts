import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile, symlink, mkdir, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { ReplayInput, LIMITS } from '../../scripts/replay/input.js';
import { actorNullSnapshot } from '../../scripts/replay/actor-null.js';
import { manifestFrom } from '../../scripts/replay/manifest.js';
import {
  parseJson,
  utcDate,
  actorNull,
  actionOf,
} from '../../scripts/replay/json.js';
import { outsideWorktree } from '../../scripts/replay/paths.js';
import { argumentsFor, main } from '../../scripts/replay/cli.js';
import {
  drain,
  runReplay,
  type Resources,
} from '../../scripts/replay/runner.js';
import { createDataSource } from '@fair-platform/pasarguard/infrastructure';
import { fixture } from '../helpers/fixtures.js';
import { syntheticReplay, syntheticLine } from '../helpers/replay.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function inputFor(lines = [syntheticLine()], versioned = true) {
  const files = await syntheticReplay(lines, versioned);
  cleanups.push(files.cleanup);
  return files;
}
async function preflight(files: Awaited<ReturnType<typeof inputFor>>) {
  const input = await ReplayInput.open(files.input, files.manifest);
  try {
    return await input.preflight();
  } finally {
    await input.close();
  }
}

describe('synthetic manifest contract', () => {
  it.each([true, false])(
    'accepts versioned=%s without rewriting bytes',
    async (versioned) => {
      const files = await inputFor(undefined, versioned);
      const result = await preflight(files);
      expect(result.groups).toBe(1);
      expect(result.children).toBe(1);
      expect(result.receiptPrecisionTruncated).toBe(1);
      expect(
        manifestFrom(JSON.stringify(files.metadata)).manifest_version,
      ).toBe(versioned ? 1 : undefined);
    },
  );
  it.each([0, 2, '1', null, true, 1.5])(
    'rejects unsupported explicit version %s',
    async (version) => {
      const files = await inputFor();
      expect(() =>
        manifestFrom(
          JSON.stringify({ ...files.metadata, manifest_version: version }),
        ),
      ).toThrow('UNSUPPORTED_MANIFEST_VERSION');
    },
  );
  it.each(['version', 'schema_version', 'format_version'])(
    'rejects alias %s',
    async (key) => {
      const files = await inputFor();
      expect(() =>
        manifestFrom(JSON.stringify({ ...files.metadata, [key]: 1 })),
      ).toThrow('UNSUPPORTED_MANIFEST_VERSION');
    },
  );
  it.each([
    { action_counts: null },
    { action_counts: {} },
    { action_counts: { user_created: 0 } },
    { action_counts: { user_created: 2 } },
    { action_counts: { 'private label': 1 } },
    { source: 'unapproved' },
    { window_days: '1' },
    { window_days: 2 },
    { distinct_payload_groups: 0 },
    { legacy_stored_rows: -1 },
    { replay_event_children: 1.5 },
    { actor_object_null_id_events: 2 },
    { groups_with_repetition_mismatch: 2 },
    { sha256_gzip: 'A'.repeat(64) },
    { notes: 'x'.repeat(513) },
    { unknown: 'private-marker' },
    { legacy_stored_rows: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed manifest %#', async (patch) => {
    const files = await inputFor();
    expect(() =>
      manifestFrom(JSON.stringify({ ...files.metadata, ...patch })),
    ).toThrow('INVALID_MANIFEST');
  });
  it('rejects missing action counts and duplicate escaped JSON keys', async () => {
    const files = await inputFor();
    const without: Record<string, unknown> = { ...files.metadata };
    delete without.action_counts;
    expect(() => manifestFrom(JSON.stringify(without))).toThrow(
      'INVALID_MANIFEST',
    );
    expect(() =>
      parseJson('{"id":1,"\\u0069d":2}', 'INVALID_MANIFEST'),
    ).toThrow('INVALID_MANIFEST');
    expect(() =>
      parseJson('{"nested":{"x":1,"x":2}}', 'INVALID_JSONL'),
    ).toThrow('INVALID_JSONL');
    expect(parseJson('{"a":{"id":1},"b":{"id":2}}', 'INVALID_JSONL')).toEqual({
      a: { id: 1 },
      b: { id: 2 },
    });
    expect(() =>
      parseJson('['.repeat(66) + '0' + ']'.repeat(66), 'INVALID_JSONL'),
    ).toThrow('INVALID_JSONL');
  });
  it.each([
    '2026-02-30T12:00:00Z',
    '2026-01-15T25:00:00Z',
    '2026-01-15',
    '2026-01-15T00:00:00+01:00',
    '2026-01-15T00:00:00.1234567Z',
  ])('rejects invalid/non-UTC date %s', (value) => {
    expect(() => utcDate(value, 'INVALID_MANIFEST')).toThrow(
      'INVALID_MANIFEST',
    );
  });
  it('accepts leap day and truncates microseconds explicitly', () => {
    expect(
      utcDate('2024-02-29 12:00:00.123456+00', 'INVALID_JSONL').toISOString(),
    ).toBe('2024-02-29T12:00:00.123Z');
  });
});

// Keep adversarial tokens as literal strings: JSON.stringify(number) would erase the defect.
const nonIntegerTokens = [
  '1.0000000000000001',
  '1.0',
  '1e0',
  '10e-1',
  '1E+0',
  '9007199254740991.1',
  '9007199254740990.9',
  '1e-400',
  '-0',
  '+1',
  '01',
  '1.',
  'NaN',
  'Infinity',
  '9007199254740992',
];
const manifestIntegerFields = [
  'manifest_version',
  'window_days',
  'distinct_payload_groups',
  'legacy_stored_rows',
  'replay_event_children',
  'groups_with_repetition_mismatch',
  'actor_object_null_id_events',
  'action_counts',
];
function rawManifestToken(
  metadata: Awaited<ReturnType<typeof inputFor>>['metadata'],
  field: string,
  token: string,
): string {
  const raw = JSON.stringify(metadata);
  if (field === 'action_counts') {
    const action = Object.keys(metadata.action_counts)[0]!;
    return raw.replace(`"${action}":1`, `"${action}":${token}`);
  }
  const value = (metadata as unknown as Record<string, unknown>)[field];
  return raw.replace(`"${field}":${String(value)}`, `"${field}":${token}`);
}

describe('P1: original JSON integer-token regression', () => {
  it.each(
    manifestIntegerFields.flatMap((field) =>
      nonIntegerTokens.map((token) => [field, token] as const),
    ),
  )(
    'rejects manifest %s token %s before any resource starts',
    async (field, token) => {
      const files = await inputFor();
      const text = rawManifestToken(files.metadata, field, token);
      const code = /^(INVALID_MANIFEST|UNSUPPORTED_MANIFEST_VERSION)$/;
      expect(() => manifestFrom(text)).toThrow(code);
      await writeFile(files.manifest, text);
      const start = vi.fn();
      const database = vi.fn();
      await expect(
        runReplay(files.input, files.manifest, false, { start, database }),
      ).rejects.toThrow(code);
      expect(start).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
    },
  );
  it.each(nonIntegerTokens)(
    'rejects JSONL legacy row token %s with checksum-valid gzip before any resource starts',
    async (token) => {
      const files = await inputFor();
      const text = JSON.stringify(syntheticLine()).replace(
        '"legacy_stored_rows":1',
        `"legacy_stored_rows":${token}`,
      );
      await files.writeInput(text);
      const start = vi.fn();
      const database = vi.fn();
      await expect(
        runReplay(files.input, files.manifest, false, { start, database }),
      ).rejects.toThrow(/^INVALID_JSONL$/);
      expect(start).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
    },
  );
  it.each(['0', '1', '9007199254740991'])(
    'accepts valid literal legacy row integer boundary %s',
    async (count) => {
      const line = syntheticLine();
      line.legacy_stored_rows = Number(count);
      const files = await inputFor([line]);
      await files.writeInput(
        JSON.stringify(line).replace(
          `"legacy_stored_rows":${Number(count)}`,
          `"legacy_stored_rows":${count}`,
        ),
      );
      expect((await preflight(files)).legacyRows).toBe(Number(count));
    },
  );
  it.each(['1', '7', '30'])(
    'accepts literal integer window %s in legacy-unversioned manifests',
    async (token) => {
      const files = await inputFor(undefined, false);
      const text = rawManifestToken(files.metadata, 'window_days', token);
      await writeFile(files.manifest, text);
      expect((await preflight(files)).groups).toBe(1);
    },
  );
  it('rejects fractional counter tokens in legacy-unversioned manifests', async () => {
    const files = await inputFor(undefined, false);
    await writeFile(
      files.manifest,
      rawManifestToken(
        files.metadata,
        'legacy_stored_rows',
        '1.0000000000000001',
      ),
    );
    const start = vi.fn();
    await expect(
      runReplay(files.input, files.manifest, false, {
        start,
        database: createDataSource,
      }),
    ).rejects.toThrow(/^INVALID_MANIFEST$/);
    expect(start).not.toHaveBeenCalled();
  });
  it('accepts maximum safe manifest counters and action values without numeric coercion', async () => {
    const files = await inputFor();
    let text = JSON.stringify(files.metadata);
    for (const field of manifestIntegerFields.filter(
      (key) => !['manifest_version', 'window_days'].includes(key),
    )) {
      // Replace raw tokens directly, including the nested action counter.
      if (field === 'action_counts') {
        const action = Object.keys(files.metadata.action_counts)[0]!;
        text = text.replace(`"${action}":1`, `"${action}":9007199254740991`);
      } else {
        text = text.replace(
          new RegExp(`"${field}":[0-9]+`),
          `"${field}":9007199254740991`,
        );
      }
    }
    const result = manifestFrom(text);
    expect(result.legacy_stored_rows).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.replay_event_children).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.values(result.action_counts)).toEqual([
      Number.MAX_SAFE_INTEGER,
    ]);
  });
  it('validates escaped contract keys by their decoded paths', async () => {
    const files = await inputFor();
    const text = rawManifestToken(
      files.metadata,
      'legacy_stored_rows',
      '1.0000000000000001',
    ).replace('"legacy_stored_rows"', '"\\u006cegacy_stored_rows"');
    expect(() => manifestFrom(text)).toThrow(/^INVALID_MANIFEST$/);
    await files.writeInput(
      JSON.stringify(syntheticLine()).replace(
        '"legacy_stored_rows":1',
        '"\\u006cegacy_stored_rows":1e0',
      ),
    );
    await expect(preflight(files)).rejects.toThrow(/^INVALID_JSONL$/);
  });
  it('preserves fractional and exponent payload numbers, array order and nested same-named fields', async () => {
    const child = fixture();
    child.enqueued_at = 0;
    child.send_at = 0;
    child.legacy_stored_rows = 0;
    child.window_days = 0;
    const files = await inputFor([syntheticLine([child])]);
    const text = JSON.stringify(syntheticLine([child]))
      .replace('"enqueued_at":0', '"enqueued_at":1790000000.123456')
      .replace('"send_at":0', '"send_at":1.790000001654321e9')
      .replace(
        '"legacy_stored_rows":0',
        '"legacy_stored_rows":1.0000000000000001',
      )
      .replace('"window_days":0', '"window_days":1e0');
    await files.writeInput(text);
    const input = await ReplayInput.open(files.input, files.manifest);
    try {
      expect((await input.preflight()).children).toBe(1);
      for await (const line of input.records()) {
        expect(line.payload[0]).toMatchObject({
          enqueued_at: 1790000000.123456,
          send_at: 1790000001.654321,
          legacy_stored_rows: 1,
          window_days: 1,
        });
      }
    } finally {
      await input.close();
    }
  });
});

describe('bounded streaming preflight', () => {
  it('counts identical sanitized groups, actor occurrence identities, actions and declared repetition mismatches', async () => {
    const nullActor = { ...fixture(), by: { id: null, username: 'synthetic' } };
    const missingActor = { ...fixture(), by: { username: 'synthetic' } };
    const missingAction = fixture();
    delete missingAction.action;
    const line = syntheticLine([
      nullActor,
      { ...fixture(), by: null },
      missingActor,
      missingAction,
      { ...fixture(), action: 'future_action' },
    ]);
    line.legacy_stored_rows = 9;
    const files = await inputFor([
      line,
      { ...line, received_at: '2026-01-15T00:00:00Z' },
    ]);
    const result = await preflight(files);
    expect(result.batches.size).toBe(1);
    expect(result.groups).toBe(2);
    expect(result.actorNull).toBe(2);
    expect(result.repetitionMismatches).toBe(2);
    expect(result.actions['(missing)']).toBe(2);
    expect(result.actions.future_action).toBe(2);
    expect(actorNull({ by: [] })).toBe(false);
    expect(actorNull({ by: {} })).toBe(false);
  });
  it('preserves child order and numeric source timestamps', async () => {
    const payload = [
      {
        ...fixture(),
        enqueued_at: 1790000000.123456,
        send_at: 1790000001.654321,
      },
      { ...fixture(), enqueued_at: 1790000000 },
    ];
    const files = await inputFor([syntheticLine(payload)]);
    const input = await ReplayInput.open(files.input, files.manifest);
    try {
      for await (const line of input.records())
        expect(line.payload).toEqual(payload);
    } finally {
      await input.close();
    }
  });
  it.each([
    'distinct_payload_groups',
    'legacy_stored_rows',
    'replay_event_children',
    'groups_with_repetition_mismatch',
    'actor_object_null_id_events',
    'action_counts',
  ])('gates %s before any DB start', async (field) => {
    const files = await inputFor();
    const manifest = {
      ...files.metadata,
      [field]: field === 'action_counts' ? { another_action: 1 } : 2,
    };
    if (field === 'replay_event_children')
      manifest.action_counts = { user_created: 2 };
    const start = vi.fn();
    await files.writeManifest(manifest);
    await expect(
      runReplay(files.input, files.manifest, false, {
        start,
        database: createDataSource,
      }),
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
  it('rejects a tampered gzip checksum before decompression or DB start', async () => {
    const files = await inputFor();
    await writeFile(files.input, Buffer.from('tampered-private-marker'));
    await expect(preflight(files)).rejects.toThrow('CHECKSUM_MISMATCH');
  });
  it.each(['not gzip', ''])('rejects invalid gzip %#', async (text) => {
    const files = await inputFor();
    await files.writeInput(text, false);
    await expect(preflight(files)).rejects.toThrow('INVALID_JSONL');
  });
  it.each([
    '',
    '\n',
    'private-marker\n',
    '{}\n',
    '{"received_at":"2026-01-15T00:00:00Z","legacy_stored_rows":0,"payload":[]}\n',
    '{"received_at":"2026-01-15T00:00:00Z","legacy_stored_rows":1,"payload":{}}\n',
    '{"received_at":"2026-01-15T00:00:00Z","legacy_stored_rows":1,"payload":[null]}\n',
  ])('rejects invalid JSONL/envelope %#', async (text) => {
    const files = await inputFor();
    await files.writeInput(text);
    await expect(preflight(files)).rejects.toThrow('INVALID_JSONL');
  });
  it('rejects non-string action and invalid UTF-8 without diagnostics', async () => {
    const files = await inputFor();
    const line = syntheticLine();
    line.payload[0]!.action = 10;
    await files.writeInput(JSON.stringify(line));
    await expect(preflight(files)).rejects.toThrow('INVALID_JSONL');
    await files.writeInput(Buffer.from([0xff, 0x0a]));
    await expect(preflight(files)).rejects.toThrow('INVALID_JSONL');
    expect(() => actionOf({ action: '(missing)' })).toThrow('INVALID_JSONL');
  });
  it('accepts CRLF and final line without newline', async () => {
    const files = await inputFor();
    const text = JSON.stringify(syntheticLine());
    await files.writeInput(text + '\r\n');
    expect((await preflight(files)).groups).toBe(1);
    await files.writeInput(text);
    expect((await preflight(files)).groups).toBe(1);
  });
  it('bounds manifest, line, batch and total decompression', async () => {
    const files = await inputFor();
    await writeFile(files.manifest, 'x'.repeat(LIMITS.manifest + 1));
    await expect(preflight(files)).rejects.toThrow('INVALID_MANIFEST');
    await files.writeInput('x'.repeat(LIMITS.line + 1));
    await expect(preflight(files)).rejects.toThrow('INPUT_TOO_LARGE');
    await files.writeInput(
      JSON.stringify(
        syntheticLine(
          Array.from({ length: LIMITS.batch + 1 }, () => ({
            action: 'user_created',
          })),
        ),
      ),
    );
    await expect(preflight(files)).rejects.toThrow('INVALID_JSONL');
    const old = LIMITS.decompressed;
    LIMITS.decompressed = 10;
    try {
      await files.writeInput(JSON.stringify(syntheticLine()));
      await expect(preflight(files)).rejects.toThrow('INPUT_TOO_LARGE');
    } finally {
      LIMITS.decompressed = old;
    }
  });
  it('rejects oversized compressed input before reading it, and truncated gzip after checksum validation', async () => {
    const files = await inputFor();
    await truncate(files.input, LIMITS.gzip + 1);
    await expect(preflight(files)).rejects.toThrow('INPUT_TOO_LARGE');
    await files.writeInput(
      files.gzip.subarray(0, files.gzip.length - 8),
      false,
    );
    await expect(preflight(files)).rejects.toThrow('INVALID_JSONL');
  });
  it('detects changes to the opened input between preflight and ingestion', async () => {
    const files = await inputFor();
    const input = await ReplayInput.open(files.input, files.manifest);
    try {
      await input.preflight();
      await writeFile(files.input, 'changed');
      await expect(input.preflight()).rejects.toThrow('INPUT_CHANGED');
    } finally {
      await input.close();
    }
  });
});

describe('safety, retries and resource cleanup', () => {
  it('requires explicit paths and offline semantics, rejects runtime URLs', () => {
    expect(() => argumentsFor([])).toThrow('INVALID_ARGUMENTS');
    expect(() =>
      argumentsFor(['--input', '/tmp/x', '--manifest', '/tmp/y']),
    ).toThrow('INVALID_ARGUMENTS');
    expect(() => argumentsFor(['--database-url', 'private-marker'])).toThrow(
      'INVALID_ARGUMENTS',
    );
    expect(
      argumentsFor([
        '--input',
        '/tmp/x',
        '--manifest',
        '/tmp/y',
        '--offline-disposable',
        '--repeat',
      ]).repeat,
    ).toBe(true);
  });
  it('rejects directories and paths in worktrees including symlinks', async () => {
    const files = await inputFor();
    await expect(
      ReplayInput.open(files.directory, files.manifest),
    ).rejects.toThrow('INPUT_UNREADABLE');
    await expect(outsideWorktree('package.json')).rejects.toThrow(
      'UNSAFE_PATH',
    );
    await symlink(process.cwd(), join(files.directory, 'repo'));
    await expect(
      outsideWorktree(join(files.directory, 'repo', 'report.json'), true),
    ).rejects.toThrow('UNSAFE_PATH');
    const linked = join(files.directory, 'linked');
    await mkdir(linked);
    await writeFile(join(linked, '.git'), 'gitdir: synthetic');
    await expect(
      outsideWorktree(join(linked, 'report.json'), true),
    ).rejects.toThrow('UNSAFE_PATH');
  });
  it('bounds a processor that never finishes and propagates technical failures', async () => {
    await expect(
      drain({ processNext: () => Promise.resolve(true) }, 1, 3),
    ).rejects.toThrow('REPLAY_FAILED');
    const processNext = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await drain({ processNext }, 1, 3)).toBe(2);
    await expect(
      drain(
        { processNext: () => Promise.reject(new Error('private-marker')) },
        1,
        3,
      ),
    ).rejects.toThrow();
  });
  it('stops its own container on failed DB initialization without leaking connection errors', async () => {
    const files = await inputFor();
    const stop = vi.fn().mockResolvedValue(undefined);
    const database = createDataSource(
      'postgres://synthetic:synthetic@127.0.0.1:1/synthetic',
    );
    vi.spyOn(database, 'initialize').mockRejectedValue(
      new Error('private-marker'),
    );
    const factories: Resources = {
      start: () =>
        Promise.resolve({ getConnectionUri: () => 'synthetic', stop }),
      database: () => database,
    };
    await expect(
      runReplay(files.input, files.manifest, false, factories),
    ).rejects.toThrow(/^REPLAY_FAILED$/);
    expect(stop).toHaveBeenCalledOnce();
  });
  it('closes DB and container on migration failure even when DB cleanup throws', async () => {
    const files = await inputFor();
    const stop = vi.fn().mockResolvedValue(undefined);
    const database = createDataSource(
      'postgres://synthetic:synthetic@127.0.0.1:1/synthetic',
    );
    vi.spyOn(database, 'initialize').mockImplementation(() => {
      Object.defineProperty(database, 'isInitialized', { value: true });
      return Promise.resolve(database);
    });
    vi.spyOn(database, 'runMigrations').mockRejectedValue(
      new Error('private-marker'),
    );
    const destroy = vi
      .spyOn(database, 'destroy')
      .mockRejectedValue(new Error('private-marker'));
    await expect(
      runReplay(files.input, files.manifest, false, {
        start: () =>
          Promise.resolve({ getConnectionUri: () => 'synthetic', stop }),
        database: () => database,
      }),
    ).rejects.toThrow('CLEANUP_FAILED');
    expect(destroy).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('prints fixed-code errors only and refuses to overwrite an existing report', async () => {
    const files = await inputFor();
    const out = join(files.directory, 'report.json');
    await writeFile(out, 'private-existing', { mode: 0o600 });
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(
      await main([
        '--input',
        files.input,
        '--manifest',
        files.manifest,
        '--offline-disposable',
        '--out',
        out,
      ]),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith('OUTPUT_FAILED');
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  });
});

describe('P2: bounded Actor-null target aggregation', () => {
  it('skips SQL for an empty subset and rejects excessive groups/children before querying', async () => {
    const database = createDataSource(
      'postgres://synthetic:synthetic@127.0.0.1:1/synthetic',
    );
    const query = vi.spyOn(database, 'query');
    expect(await actorNullSnapshot(database, [])).toEqual({
      storedChildOccurrences: 0,
      accepted: 0,
      rejected: 0,
      unresolved: 0,
      issues: {},
    });
    await expect(
      actorNullSnapshot(
        database,
        Array.from({ length: LIMITS.groups + 1 }, () => ({
          batch_id: '1',
          indices: [],
        })),
      ),
    ).rejects.toThrow('REPLAY_FAILED');
    await expect(
      actorNullSnapshot(database, [
        { batch_id: '1', indices: Array<number>(LIMITS.children + 1).fill(0) },
      ]),
    ).rejects.toThrow('REPLAY_FAILED');
    expect(query).not.toHaveBeenCalled();
  });
});
