import { describe, expect, it } from 'vitest';
import {
  daysInJalaliMonth,
  gregorianToJalali,
  isJalaliLeapYear,
  isValidGregorianDate,
  isValidJalaliDate,
  jalaliToGregorian,
  type CalendarDate,
} from '@fair-platform/calendar';

const DAY_MS = 86_400_000;
const START = Date.UTC(2011, 10, 19);
const END_EXCLUSIVE = Date.UTC(2026, 10, 20);

// An independent reference implementation: Node's ICU-backed Persian calendar.
// Pinning Node/ICU in CI is essential so runtime upgrades also re-run the audit.
const referenceCalendar = new Intl.DateTimeFormat('en-US', {
  calendar: 'persian',
  timeZone: 'UTC',
  numberingSystem: 'latn',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

// Published Nowruz dates transcribed from the Iranian official leap-year table.
// Source: https://calendar.ut.ac.ir/documents/2139738/7092644/Kabise+Shamsi+1206-1498.pdf
// Readable transcription: https://github.com/roozbehp/persiancalendar/blob/main/kabise.txt
// A star in that reference marks a leap Jalali year.
const OFFICIAL_NOWRUZ: ReadonlyArray<readonly [number, string, boolean]> = [
  [1390, '2011-03-21', false],
  [1391, '2012-03-20', true],
  [1392, '2013-03-21', false],
  [1393, '2014-03-21', false],
  [1394, '2015-03-21', false],
  [1395, '2016-03-20', true],
  [1396, '2017-03-21', false],
  [1397, '2018-03-21', false],
  [1398, '2019-03-21', false],
  [1399, '2020-03-20', true],
  [1400, '2021-03-21', false],
  [1401, '2022-03-21', false],
  [1402, '2023-03-21', false],
  [1403, '2024-03-20', true],
  [1404, '2025-03-21', false],
  [1405, '2026-03-21', false],
  [1406, '2027-03-21', false],
];

function gregorianFields(timestamp: number): CalendarDate {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function icuJalaliDate(timestamp: number): CalendarDate {
  const parts = referenceCalendar.formatToParts(new Date(timestamp));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value || !/^\d+$/.test(value))
      throw new Error(`UNEXPECTED_ICU_${type}`);
    return Number(value);
  };
  return { year: field('year'), month: field('month'), day: field('day') };
}

function timestampOfGregorian(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

describe('Jalali calendar: exhaustive 15-year audit', () => {
  it('converts every Gregorian day from 2011-11-19 to 2026-11-19 exactly like ICU, round-trips without missing/duplicate days', () => {
    const seen = new Set<string>();
    let checked = 0;
    let previousJalali: CalendarDate | undefined;

    for (
      let timestamp = START;
      timestamp < END_EXCLUSIVE;
      timestamp += DAY_MS
    ) {
      const gregorian = gregorianFields(timestamp);
      const jalali = gregorianToJalali(gregorian);
      const label = new Date(timestamp).toISOString().slice(0, 10);

      expect(jalali, `ICU mismatch on Gregorian ${label}`).toEqual(
        icuJalaliDate(timestamp),
      );
      expect(
        jalaliToGregorian(jalali),
        `round-trip mismatch on ${label}`,
      ).toEqual(gregorian);
      expect(isValidJalaliDate(jalali), `invalid Jalali date on ${label}`).toBe(
        true,
      );

      const jalaliKey = `${jalali.year}-${jalali.month}-${jalali.day}`;
      expect(seen.has(jalaliKey), `duplicate Jalali day ${jalaliKey}`).toBe(
        false,
      );
      seen.add(jalaliKey);

      if (previousJalali) {
        const previousKey =
          previousJalali.year * 10000 +
          previousJalali.month * 100 +
          previousJalali.day;
        const currentKey =
          jalali.year * 10000 + jalali.month * 100 + jalali.day;
        expect(
          currentKey,
          `non-increasing Jalali date on ${label}`,
        ).toBeGreaterThan(previousKey);
      }
      previousJalali = jalali;
      checked++;
    }

    expect(checked).toBe((END_EXCLUSIVE - START) / DAY_MS);
    expect(seen.size).toBe(checked);
  });

  it.each(OFFICIAL_NOWRUZ)(
    'matches published Nowruz and leap-year reference for %i',
    (year, isoDate, isLeap) => {
      const [gy, gm, gd] = isoDate.split('-').map(Number);
      expect(gregorianToJalali({ year: gy!, month: gm!, day: gd! })).toEqual({
        year,
        month: 1,
        day: 1,
      });
      expect(jalaliToGregorian({ year, month: 1, day: 1 })).toEqual({
        year: gy,
        month: gm,
        day: gd,
      });
      expect(isJalaliLeapYear(year)).toBe(isLeap);
    },
  );

  it('verifies every Shahrivar 31 / Mehr 1 boundary in 1390–1405', () => {
    for (let year = 1390; year <= 1405; year++) {
      expect(daysInJalaliMonth(year, 6)).toBe(31);
      expect(isValidJalaliDate({ year, month: 6, day: 31 })).toBe(true);

      const lastShahrivar = timestampOfGregorian(
        jalaliToGregorian({ year, month: 6, day: 31 }),
      );
      const firstMehr = timestampOfGregorian(
        jalaliToGregorian({ year, month: 7, day: 1 }),
      );
      expect(firstMehr - lastShahrivar, `Shahrivar ${year}`).toBe(DAY_MS);
      expect(gregorianToJalali(gregorianFields(firstMehr - DAY_MS))).toEqual({
        year,
        month: 6,
        day: 31,
      });
      expect(gregorianToJalali(gregorianFields(firstMehr))).toEqual({
        year,
        month: 7,
        day: 1,
      });
    }
  });

  it('verifies every Esfand 29/30 and Farvardin 1 boundary against published leap years', () => {
    for (const [year, , leap] of OFFICIAL_NOWRUZ.slice(0, -1)) {
      expect(daysInJalaliMonth(year, 12), `Esfand length ${year}`).toBe(
        leap ? 30 : 29,
      );
      expect(isValidJalaliDate({ year, month: 12, day: 30 })).toBe(leap);

      const lastEsfand = timestampOfGregorian(
        jalaliToGregorian({ year, month: 12, day: leap ? 30 : 29 }),
      );
      const newYear = timestampOfGregorian(
        jalaliToGregorian({ year: year + 1, month: 1, day: 1 }),
      );
      expect(newYear - lastEsfand, `Esfand/Farvardin ${year}`).toBe(DAY_MS);
    }
    expect(jalaliToGregorian({ year: 1403, month: 12, day: 30 })).toEqual({
      year: 2025,
      month: 3,
      day: 20,
    });
    expect(jalaliToGregorian({ year: 1404, month: 1, day: 1 })).toEqual({
      year: 2025,
      month: 3,
      day: 21,
    });
  });

  it('verifies every month length and contiguous monthly boundary over 1390–1405', () => {
    for (let year = 1390; year <= 1405; year++) {
      for (let month = 1; month <= 12; month++) {
        const length = daysInJalaliMonth(year, month);
        const first = timestampOfGregorian(
          jalaliToGregorian({ year, month, day: 1 }),
        );
        const nextYear = month === 12 ? year + 1 : year;
        const nextMonth = month === 12 ? 1 : month + 1;
        const exclusiveEnd = timestampOfGregorian(
          jalaliToGregorian({ year: nextYear, month: nextMonth, day: 1 }),
        );
        expect((exclusiveEnd - first) / DAY_MS, `${year}/${month}`).toBe(
          length,
        );
        expect(
          gregorianToJalali(gregorianFields(exclusiveEnd - DAY_MS)),
        ).toEqual({
          year,
          month,
          day: length,
        });
        expect(gregorianToJalali(gregorianFields(exclusiveEnd))).toEqual({
          year: nextYear,
          month: nextMonth,
          day: 1,
        });
      }
    }
  });

  it('rejects invalid dates instead of silently normalizing or losing them', () => {
    for (const date of [
      { year: 1404, month: 12, day: 30 },
      { year: 1403, month: 12, day: 31 },
      { year: 1403, month: 6, day: 32 },
      { year: 1403, month: 7, day: 31 },
      { year: 1403, month: 13, day: 1 },
      { year: 1403, month: 0, day: 1 },
      { year: 1403, month: 1, day: 0 },
      { year: 0, month: 1, day: 1 },
      { year: 1403.5, month: 1, day: 1 },
    ]) {
      expect(isValidJalaliDate(date)).toBe(false);
      expect(() => jalaliToGregorian(date)).toThrow('INVALID_JALALI_DATE');
    }
    expect(isValidGregorianDate({ year: 2024, month: 2, day: 29 })).toBe(true);
    for (const date of [
      { year: 2025, month: 2, day: 29 },
      { year: 2100, month: 2, day: 29 },
      { year: 2026, month: 9, day: 31 },
      { year: 2026, month: 2, day: 0 },
      { year: 2026, month: 1.5, day: 1 },
    ]) {
      expect(isValidGregorianDate(date)).toBe(false);
      expect(() => gregorianToJalali(date)).toThrow('INVALID_GREGORIAN_DATE');
    }
  });
});
