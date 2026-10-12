import { open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { fingerprint } from '@fair-platform/pasarguard';
import { fail, ReplayError } from './errors.js';
import {
  actorNull,
  actionOf,
  integer,
  object,
  parseJson,
  utcDate,
} from './json.js';
import { manifestFrom, type Manifest } from './manifest.js';
import { outsideWorktree } from './paths.js';

export const LIMITS = {
  manifest: 65536,
  gzip: 128 * 1024 * 1024,
  decompressed: 512 * 1024 * 1024,
  line: 1024 * 1024,
  batch: 1000,
  groups: 100000,
  children: 1000000,
};
export interface RecordLine {
  receivedAt: Date;
  payload: Record<string, unknown>[];
  legacyRows: number;
  receiptPrecisionTruncated: boolean;
}
export interface Preflight {
  groups: number;
  children: number;
  legacyRows: number;
  repetitionMismatches: number;
  actorNull: number;
  actions: Record<string, number>;
  receiptPrecisionTruncated: number;
  batches: Map<string, { children: number; actorIndices: number[] }>;
}
function recordLine(bytes: Buffer): RecordLine {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('INVALID_JSONL');
  }
  const data = parseJson(text, 'INVALID_JSONL');
  if (
    !object(data) ||
    Object.keys(data).length !== 3 ||
    !Object.hasOwn(data, 'received_at') ||
    !integer(data.legacy_stored_rows) ||
    !Array.isArray(data.payload) ||
    !data.payload.length ||
    data.payload.length > LIMITS.batch ||
    !data.payload.every(object)
  )
    fail('INVALID_JSONL');
  return {
    receivedAt: utcDate(data.received_at, 'INVALID_JSONL'),
    payload: data.payload,
    legacyRows: data.legacy_stored_rows,
    receiptPrecisionTruncated: /\.\d{3}\d*[1-9]\d*(?:Z|\+00)$/.test(
      data.received_at as string,
    ),
  };
}
export class ReplayInput {
  private constructor(
    readonly manifest: Manifest,
    private readonly file: FileHandle,
    private readonly signature: string,
  ) {}
  static async open(input: string, manifest: string): Promise<ReplayInput> {
    let file: FileHandle | undefined;
    try {
      const manifestPath = await outsideWorktree(manifest);
      const mf = await open(
        manifestPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let parsed: Manifest;
      try {
        const stat = await mf.stat();
        if (!stat.isFile()) fail('INPUT_UNREADABLE');
        if (stat.size > LIMITS.manifest) fail('INVALID_MANIFEST');
        // Bounded read, including files that grow after stat.
        const bytes = Buffer.alloc(LIMITS.manifest + 1);
        const { bytesRead } = await mf.read(bytes, 0, bytes.length, 0);
        if (bytesRead > LIMITS.manifest) fail('INVALID_MANIFEST');
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, bytesRead),
          );
        } catch {
          return fail('INVALID_MANIFEST');
        }
        parsed = manifestFrom(text);
      } finally {
        await mf.close();
      }
      file = await open(
        await outsideWorktree(input),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (!stat.isFile()) fail('INPUT_UNREADABLE');
      if (stat.size > LIMITS.gzip) fail('INPUT_TOO_LARGE');
      const instance = new ReplayInput(
        parsed,
        file,
        `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      );
      await instance.checksum();
      return instance;
    } catch (error) {
      await file?.close();
      if (error instanceof ReplayError) throw error;
      return fail('INPUT_UNREADABLE');
    }
  }
  async close(): Promise<void> {
    await this.file.close();
  }
  async unchanged(): Promise<void> {
    const s = await this.file.stat();
    if (`${s.size}:${s.mtimeMs}:${s.ctimeMs}` !== this.signature)
      fail('INPUT_CHANGED');
  }
  private async *bytes(): AsyncGenerator<Buffer> {
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  }
  private async checksum(): Promise<void> {
    const stream = Readable.from(this.bytes());
    const hash = createHash('sha256');
    let total = 0;
    try {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        total += bytes.length;
        if (total > LIMITS.gzip) fail('INPUT_TOO_LARGE');
        hash.update(bytes);
      }
      if (hash.digest('hex') !== this.manifest.sha256_gzip)
        fail('CHECKSUM_MISMATCH');
      await this.unchanged();
    } finally {
      stream.destroy();
    }
  }
  async *records(): AsyncGenerator<RecordLine> {
    await this.unchanged();
    const source = Readable.from(this.bytes());
    const hash = createHash('sha256');
    let compressed = 0;
    const gate = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        if (compressed > LIMITS.gzip) {
          callback(new ReplayError('INPUT_TOO_LARGE'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const gzip = createGunzip();
    // Attach rejection immediately: consumers may throw before the stream finishes.
    const completed = pipeline(source, gate, gzip).then(
      () => null,
      (error: unknown) => error,
    );
    let pending = Buffer.alloc(0);
    let total = 0;
    let groups = 0;
    let children = 0;
    try {
      for await (const item of gzip) {
        const chunk = item as Buffer;
        total += chunk.length;
        if (total > LIMITS.decompressed) fail('INPUT_TOO_LARGE');
        let start = 0;
        for (let at = 0; at < chunk.length; at++) {
          if (chunk[at] !== 10) continue;
          if (pending.length + at - start > LIMITS.line)
            fail('INPUT_TOO_LARGE');
          const line = recordLine(
            Buffer.concat([pending, chunk.subarray(start, at)]),
          );
          groups++;
          children += line.payload.length;
          if (groups > LIMITS.groups || children > LIMITS.children)
            fail('INPUT_TOO_LARGE');
          yield line;
          pending = Buffer.alloc(0);
          start = at + 1;
        }
        if (pending.length + chunk.length - start > LIMITS.line)
          fail('INPUT_TOO_LARGE');
        pending = Buffer.concat([pending, chunk.subarray(start)]);
      }
      if (pending.length) {
        const line = recordLine(pending);
        groups++;
        children += line.payload.length;
        if (groups > LIMITS.groups || children > LIMITS.children)
          fail('INPUT_TOO_LARGE');
        yield line;
      }
      if (await completed) fail('INVALID_JSONL');
      if (!groups) fail('INVALID_JSONL');
      if (hash.digest('hex') !== this.manifest.sha256_gzip)
        fail('INPUT_CHANGED');
      await this.unchanged();
    } catch (error) {
      if (error instanceof ReplayError) throw error;
      fail('INVALID_JSONL');
    } finally {
      source.destroy();
      gate.destroy();
      gzip.destroy();
      await completed;
    }
  }
  async preflight(): Promise<Preflight> {
    const result: Preflight = {
      groups: 0,
      children: 0,
      legacyRows: 0,
      repetitionMismatches: 0,
      actorNull: 0,
      actions: Object.create(null) as Record<string, number>,
      receiptPrecisionTruncated: 0,
      batches: new Map(),
    };
    for await (const line of this.records()) {
      result.groups++;
      if (line.receiptPrecisionTruncated) result.receiptPrecisionTruncated++;
      result.children += line.payload.length;
      result.legacyRows += line.legacyRows;
      if (!Number.isSafeInteger(result.legacyRows))
        fail('INPUT_INTEGRITY_FAILED');
      if (line.legacyRows !== line.payload.length)
        result.repetitionMismatches++;
      // Source text is deliberately not retained; Date conversion always truncates to milliseconds.
      const indices: number[] = [];
      line.payload.forEach((child, index) => {
        const action = actionOf(child);
        result.actions[action] = (result.actions[action] ?? 0) + 1;
        if (actorNull(child)) {
          result.actorNull++;
          indices.push(index);
        }
      });
      result.batches.set(fingerprint(line.payload), {
        children: line.payload.length,
        actorIndices: indices,
      });
    }
    const m = this.manifest;
    if (
      result.groups !== m.distinct_payload_groups ||
      result.children !== m.replay_event_children ||
      result.legacyRows !== m.legacy_stored_rows ||
      result.repetitionMismatches !== m.groups_with_repetition_mismatch ||
      result.actorNull !== m.actor_object_null_id_events ||
      JSON.stringify(Object.entries(result.actions).sort()) !==
        JSON.stringify(Object.entries(m.action_counts).sort())
    )
      fail('INPUT_INTEGRITY_FAILED');
    return result;
  }
}
