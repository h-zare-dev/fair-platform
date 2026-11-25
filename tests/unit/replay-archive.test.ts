import { describe, expect, it } from 'vitest';
import { jalaliValidityWindow } from '@fair-platform/calendar';
import { fullArchiveDays } from '../../apps/api/dist/owner/infrastructure/replay-archive.js';
import { manifestFrom } from '../../scripts/replay/dist/manifest.js';

describe('private archive coverage', () => {
  const zone = 'Asia/Tehran';

  it('recognizes a 90-day manifest and all four requested Jalali months', () => {
    const dates = jalaliValidityWindow(zone, '1405-05-01', '1405-08-30');
    const start = new Date(dates.fromUtc);
    const end = new Date(dates.untilUtc!);
    expect(fullArchiveDays(start, end, zone)).toEqual({
      from: '1405-05-01',
      to: '1405-08-30',
    });
    const days = (end.getTime() - start.getTime()) / 86400000;
    expect(days).toBe(122);
    for (const window of [90, days]) {
      const manifest = manifestFrom(
        JSON.stringify({
          source: 'legacy-pasarjew-postgresql',
          window_days: window,
          cutoff_utc: dates.untilUtc,
          distinct_payload_groups: 1,
          legacy_stored_rows: 1,
          replay_event_children: 1,
          groups_with_repetition_mismatch: 0,
          actor_object_null_id_events: 0,
          action_counts: { user_created: 1 },
          sha256_gzip: 'a'.repeat(64),
        }),
      );
      expect(manifest.window_days).toBe(window);
    }
  });

  it('excludes clipped boundary days even when they contain an event', () => {
    const dates = jalaliValidityWindow(zone, '1405-05-01', '1405-08-30');
    const start = new Date(Date.parse(dates.fromUtc) + 1);
    const end = new Date(Date.parse(dates.untilUtc!) - 1);
    expect(fullArchiveDays(start, end, zone)).toEqual({
      from: '1405-05-02',
      to: '1405-08-29',
    });
  });
});
