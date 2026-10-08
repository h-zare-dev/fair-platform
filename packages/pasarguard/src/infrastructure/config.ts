import { z } from 'zod';

const positive = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);
const configSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  PASARGUARD_SOURCE_INSTANCE_ID: z.string().min(1).max(100).default('primary'),
  RAW_WEBHOOK_RETENTION_DAYS: positive(14).refine((value) => value <= 36500),
  WEBHOOK_NORMALIZATION_MAX_ATTEMPTS: positive(5),
  WEBHOOK_WORKER_POLL_INTERVAL_MS: positive(1000).refine(
    (value) => value <= 2147483647,
  ),
});
export type IngestionConfig = z.infer<typeof configSchema>;
export function readConfig(
  environment: Record<string, string | undefined> = process.env,
): IngestionConfig {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) throw new Error('INVALID_INGESTION_CONFIGURATION');
  return parsed.data;
}
