import { z } from 'zod';

const singleton = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Object.hasOwn(value, 'action') && Object.hasOwn(value, 'user'),
  );
export const envelopeSchema = z.union([z.array(z.unknown()).min(1), singleton]);

export function children(payload: unknown): unknown[] {
  const parsed = envelopeSchema.parse(payload);
  return Array.isArray(parsed) ? parsed : [parsed];
}
