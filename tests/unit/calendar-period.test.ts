import { describe, expect, it, vi } from 'vitest';
import {
  jalaliValidityWindow,
  jalaliLocalMidnightUtc,
  localJalaliDate,
  parseJalaliDate,
  validateTimeZone,
} from '@fair-platform/calendar';

describe('FP-004 local-calendar assignment windows', () => {
  it('includes the full selected final day and defaults an omitted start to today in Tehran', () => {
    expect(
      jalaliValidityWindow('Asia/Tehran', '1405-09-10', '1405-09-30'),
    ).toEqual({
      startDate: '1405-09-10',
      endDate: '1405-09-30',
      zone: 'Asia/Tehran',
      fromUtc: '2026-11-30T20:30:00.000Z',
      untilUtc: '2026-12-21T20:30:00.000Z',
    });
    expect(
      jalaliValidityWindow(
        'Asia/Tehran',
        null,
        null,
        new Date('2026-11-19T21:10:00Z'),
      ).startDate,
    ).toBe('1405-08-29');
    expect(
      localJalaliDate(new Date('2026-11-19T20:29:59.999Z'), 'Asia/Tehran'),
    ).toBe('1405-08-28');
  });

  it('allows 31 Shahrivar, rejects nonleap 30 Esfand and validates IANA zones', () => {
    expect(parseJalaliDate('1405-06-31')).toEqual({
      year: 1405,
      month: 6,
      day: 31,
    });
    expect(() => parseJalaliDate('1404-12-30')).toThrow('INVALID_JALALI_DATE');
    expect(() =>
      jalaliValidityWindow('Asia/Tehran', '1405-09-30', '1405-09-10'),
    ).toThrow('INVALID_DATE_WINDOW');
    expect(() => validateTimeZone('Broken/Zone')).toThrow(
      'INVALID_FAIR_TIME_ZONE',
    );
  });

  it('does not add 86400 seconds through Berlin DST transitions', () => {
    const spring = jalaliValidityWindow(
      'Europe/Berlin',
      '1405-01-09',
      '1405-01-09',
    );
    const autumn = jalaliValidityWindow(
      'Europe/Berlin',
      '1405-08-03',
      '1405-08-03',
    );
    expect(
      (Date.parse(spring.untilUtc!) - Date.parse(spring.fromUtc)) / 3600000,
    ).toBe(23);
    expect(
      (Date.parse(autumn.untilUtc!) - Date.parse(autumn.fromUtc)) / 3600000,
    ).toBe(25);
  });

  it('preserves exact day boundaries and rejects skipped local dates', () => {
    expect(jalaliLocalMidnightUtc('1405-01-01', 'Asia/Tehran')).toBe(
      '2026-03-20T20:30:00.000Z',
    );
    // Pacific/Apia skipped 2011-12-30 altogether when crossing the dateline.
    expect(() => jalaliLocalMidnightUtc('1390-10-09', 'Pacific/Apia')).toThrow(
      'NONEXISTENT_LOCAL_DATE',
    );
  });

  it('reuses bounded native date formatters during high-volume archive replay', () => {
    const constructor = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      const instant = new Date('2026-11-24T00:00:00Z');
      const days = Array.from({ length: 1000 }, () =>
        localJalaliDate(instant, 'Pacific/Tongatapu'),
      );
      expect(new Set(days).size).toBe(1);
      // One zone validation and one date formatter, instead of 2,000
      // native ICU objects and unbounded resident memory.
      expect(constructor.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      constructor.mockRestore();
    }
  });
});
