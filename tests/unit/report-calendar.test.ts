import { describe, expect, it } from 'vitest';
import {
  daysInReportMonth,
  parseReportDate,
  readableReportDate,
  reportDateFromJalali,
  reportDateToJalali,
  reportMonthLabel,
  reportWeekday,
  shiftReportMonth,
} from '../../apps/web/lib/report-calendar.js';

describe('Owner report calendar-only presentation', () => {
  it('keeps Tehran-local source dates while switching Jalali and Gregorian labels', () => {
    const jalali = reportDateToJalali('2026-11-20', 'gregorian');
    expect(reportDateFromJalali(jalali, 'gregorian')).toBe('2026-11-20');
    expect(reportDateFromJalali(jalali, 'jalali')).toBe(jalali);
    expect(reportMonthLabel('2026-11-01', 'gregorian')).toContain('نوامبر');
    expect(readableReportDate('2026-11-20', 'gregorian')).toContain('نوامبر');
    expect(reportWeekday({ year: 2026, month: 11, day: 20 }, 'gregorian')).toBe(
      5,
    );
  });

  it('provides date-only month/day selection through leap boundaries', () => {
    expect(daysInReportMonth(2024, 2, 'gregorian')).toBe(29);
    expect(daysInReportMonth(2026, 2, 'gregorian')).toBe(28);
    expect(daysInReportMonth(1403, 12, 'jalali')).toBe(30);
    expect(daysInReportMonth(1404, 12, 'jalali')).toBe(29);
    expect(() => parseReportDate('2026-02-29', 'gregorian')).toThrow();
    expect(() => parseReportDate('1404-12-30', 'jalali')).toThrow();
    expect(shiftReportMonth({ year: 2026, month: 12, day: 14 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(shiftReportMonth({ year: 1405, month: 1, day: 1 }, -1)).toEqual({
      year: 1404,
      month: 12,
      day: 1,
    });
  });
});
