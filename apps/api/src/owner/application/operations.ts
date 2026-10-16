import { z } from 'zod';
const utc = z.iso
  .datetime({ offset: false })
  .refine((v) => !/\.\d{7,}Z$/.test(v) && new Date(v).getUTCFullYear() >= 1);
const micros = (v: string) =>
  BigInt(Date.parse(v.replace(/\.\d+Z$/, 'Z'))) * 1000n +
  BigInt((/\.(\d+)Z$/.exec(v)?.[1] ?? '').padEnd(6, '0'));
const id = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const cursorSchema = z
  .object({
    time: utc,
    id,
    start: utc,
    end: utc,
    source: z.string().max(100).nullable(),
    kind: z.enum(['events', 'issues']),
  })
  .strict();
const querySchema = z
  .object({
    window: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
    start: utc.optional(),
    end: utc.optional(),
    source: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .refine((v) => v <= 100)
      .default(25),
    cursor: z.string().max(1500).optional(),
  })
  .strict();
export interface OperationFilter {
  start: string;
  end: string;
  source: string | null;
  limit: number;
  cursor: z.infer<typeof cursorSchema> | null;
}
export function operationFilter(
  input: unknown,
  kind: 'summary' | 'events' | 'issues',
  now = new Date(),
): OperationFilter {
  const query = querySchema.parse(input);
  if (kind === 'summary' && query.cursor) throw new Error('INVALID_FILTER');
  const cursor = query.cursor
    ? cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      )
    : null;
  if (cursor && cursor.kind !== kind) throw new Error('INVALID_CURSOR');
  const source = query.source ?? null;
  const hours = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 }[query.window];
  if (!!query.start !== !!query.end) throw new Error('INVALID_RANGE');
  const end = query.end ?? cursor?.end ?? now.toISOString();
  const start =
    query.start ??
    cursor?.start ??
    new Date(Date.parse(end) - hours * 3600000).toISOString();
  utc.parse(start);
  utc.parse(end);
  const span = micros(end) - micros(start);
  if (!(span > 0n && span <= 30n * 86400000000n))
    throw new Error('INVALID_RANGE');
  if (
    cursor &&
    (cursor.source !== source ||
      cursor.start !== start ||
      cursor.end !== end ||
      micros(cursor.time) < micros(start) ||
      micros(cursor.time) >= micros(end))
  )
    throw new Error('INVALID_CURSOR');
  return { start, end, source, limit: query.limit, cursor };
}
export function nextCursor(
  filter: OperationFilter,
  kind: 'events' | 'issues',
  time: string,
  rowId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      time,
      id: rowId,
      start: filter.start,
      end: filter.end,
      source: filter.source,
      kind,
    }),
  ).toString('base64url');
}
export interface OperationsReader {
  summary(filter: OperationFilter): Promise<unknown>;
  events(filter: OperationFilter): Promise<unknown>;
  issues(filter: OperationFilter): Promise<unknown>;
  ready(): Promise<void>;
}
export class OwnerOperations {
  constructor(private readonly reader: OperationsReader) {}
  read(
    kind: 'summary' | 'events' | 'issues',
    input: unknown,
  ): Promise<unknown> {
    return this.reader[kind](operationFilter(input, kind));
  }
}
