import { fail } from './errors.js';
import { integer, object, parseJson, utcDate } from './json.js';

export interface Manifest {
  manifest_version?: 1;
  source: 'legacy-pasarjew-postgresql';
  window_days: 1 | 7 | 30;
  cutoff_utc: string;
  distinct_payload_groups: number;
  legacy_stored_rows: number;
  replay_event_children: number;
  groups_with_repetition_mismatch: number;
  actor_object_null_id_events: number;
  action_counts: Record<string, number>;
  sha256_gzip: string;
  notes?: string;
}
const required = [
  'source',
  'window_days',
  'cutoff_utc',
  'distinct_payload_groups',
  'legacy_stored_rows',
  'replay_event_children',
  'groups_with_repetition_mismatch',
  'actor_object_null_id_events',
  'action_counts',
  'sha256_gzip',
];
export function manifestFrom(text: string): Manifest {
  const data = parseJson(text, 'INVALID_MANIFEST');
  if (!object(data)) fail('INVALID_MANIFEST');
  if (Object.hasOwn(data, 'manifest_version') && data.manifest_version !== 1)
    fail('UNSUPPORTED_MANIFEST_VERSION');
  if (
    ['version', 'schema_version', 'format_version'].some((key) =>
      Object.hasOwn(data, key),
    )
  )
    fail('UNSUPPORTED_MANIFEST_VERSION');
  if (
    Object.keys(data).some(
      (key) => ![...required, 'manifest_version', 'notes'].includes(key),
    ) ||
    required.some((key) => !Object.hasOwn(data, key))
  )
    fail('INVALID_MANIFEST');
  if (
    data.source !== 'legacy-pasarjew-postgresql' ||
    ![1, 7, 30].includes(data.window_days as number)
  )
    fail('INVALID_MANIFEST');
  utcDate(data.cutoff_utc, 'INVALID_MANIFEST');
  if (
    !integer(data.distinct_payload_groups, 1) ||
    !integer(data.legacy_stored_rows) ||
    !integer(data.replay_event_children, 1) ||
    !integer(
      data.groups_with_repetition_mismatch,
      0,
      data.distinct_payload_groups,
    ) ||
    !integer(data.actor_object_null_id_events, 0, data.replay_event_children)
  )
    fail('INVALID_MANIFEST');
  if (
    typeof data.sha256_gzip !== 'string' ||
    !/^[0-9a-f]{64}$/.test(data.sha256_gzip)
  )
    fail('INVALID_MANIFEST');
  if (
    Object.hasOwn(data, 'notes') &&
    (typeof data.notes !== 'string' || Array.from(data.notes).length > 512)
  )
    fail('INVALID_MANIFEST');
  if (!object(data.action_counts) || !Object.keys(data.action_counts).length)
    fail('INVALID_MANIFEST');
  let sum = 0;
  for (const [key, count] of Object.entries(data.action_counts)) {
    if (
      !(key === '(missing)' || /^[A-Za-z0-9_:-]{1,64}$/.test(key)) ||
      !integer(count, 1)
    )
      fail('INVALID_MANIFEST');
    sum += count;
    if (!Number.isSafeInteger(sum)) fail('INVALID_MANIFEST');
  }
  if (sum !== data.replay_event_children) fail('INVALID_MANIFEST');
  return data as unknown as Manifest;
}
