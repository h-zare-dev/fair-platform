import { describe, expect, it } from 'vitest';
import { formatJalaliDate, gregorianToJalali } from '@fair-platform/calendar';
import {
  groupShadowReportDays,
  jalaliToReportDate,
  parseReportCalendar,
  parseReportWeekStart,
  reportDateToJalali,
  shadowPeriodBounds,
} from '../../apps/api/dist/owner/application/shadow-report-periods.js';

const jalali = (year: number, month: number, day: number) =>
  formatJalaliDate(gregorianToJalali({ year, month, day }));

describe('Owner-only SHADOW per-admin report periods', () => {
  it('accepts an independent display calendar and uses real Gregorian months', () => {
    expect(parseReportCalendar()).toBe('jalali');
    expect(parseReportCalendar('GREGORIAN')).toBe('gregorian');
    expect(() => parseReportCalendar('persian-timezone')).toThrow(
      'INVALID_REPORT_CALENDAR',
    );
    expect(
      jalaliToReportDate(
        reportDateToJalali('2024-02-29', 'gregorian'),
        'gregorian',
      ),
    ).toBe('2024-02-29');
    expect(() => reportDateToJalali('2026-02-30', 'gregorian')).toThrow(
      'INVALID_GREGORIAN_DATE',
    );
    const lastFebruary = reportDateToJalali('2024-02-29', 'gregorian');
    const firstMarch = reportDateToJalali('2024-03-01', 'gregorian');
    expect(
      shadowPeriodBounds(lastFebruary, 'month', 'SATURDAY', 'gregorian'),
    ).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(
      shadowPeriodBounds(firstMarch, 'month', 'SATURDAY', 'gregorian'),
    ).toEqual({
      start: '2024-03-01',
      end: '2024-03-31',
    });
    expect(
      shadowPeriodBounds(
        reportDateToJalali('2026-11-20', 'gregorian'),
        'week',
        'SATURDAY',
        'gregorian',
      ),
    ).toEqual({
      start: '2026-11-14',
      end: '2026-11-20',
    });
  });

  it('rolls several administrators into one row per date/period without finalizing held charges', () => {
    const localDay = reportDateToJalali('2026-11-20', 'gregorian');
    const records = [
      {
        localDay,
        adminDays: 3,
        status: 'SHADOW_READY' as const,
        chargeToman: '400000',
        creditToman: '100000',
        netToman: '300000',
        chargeBytes: (200n * 1073741824n).toString(),
        entryCount: 4,
        holdCount: 0,
      },
      {
        localDay,
        adminDays: 2,
        status: 'PENDING_REVIEW' as const,
        chargeToman: null,
        creditToman: null,
        netToman: null,
        chargeBytes: null,
        entryCount: 0,
        holdCount: 2,
      },
    ];
    for (const period of ['day', 'week', 'month'] as const) {
      const rows = groupShadowReportDays(
        records,
        period,
        'SATURDAY',
        localDay,
        localDay,
        'gregorian',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        observedDays: 5,
        readyDays: 3,
        pendingDays: 2,
        holdCount: 2,
        readyChargeToman: '400000',
        readyCreditToman: '100000',
        readyNetToman: '300000',
        readyChargeBytes: (200n * 1073741824n).toString(),
        status: 'PENDING_REVIEW',
        chargeToman: null,
        netToman: null,
      });
    }
  });
  it('defaults to Saturday through Friday, but honours validated ENV alternatives', () => {
    expect(parseReportWeekStart()).toBe('SATURDAY');
    expect(parseReportWeekStart('sunday')).toBe('SUNDAY');
    expect(() => parseReportWeekStart('TUESDAY_OR_ELSE')).toThrow(
      'INVALID_REPORT_WEEK_START_DAY',
    );
    const saturday = jalali(2026, 11, 21);
    const friday = jalali(2026, 11, 27);
    expect(shadowPeriodBounds(saturday, 'week', 'SATURDAY')).toEqual({
      start: saturday,
      end: friday,
    });
    expect(shadowPeriodBounds(friday, 'week', 'SATURDAY')).toEqual({
      start: saturday,
      end: friday,
    });
    expect(shadowPeriodBounds(saturday, 'week', 'SUNDAY')).toEqual({
      start: jalali(2026, 11, 15),
      end: saturday,
    });
  });

  it('never finalizes a week/month containing a held day; only exposes ready subtotals', () => {
    const saturday = jalali(2026, 11, 21);
    const sunday = jalali(2026, 11, 22);
    const data = [
      {
        localDay: saturday,
        status: 'SHADOW_READY' as const,
        chargeToman: '100000',
        chargeBytes: '53687091200',
        creditToman: '50000',
        netToman: '50000',
        entryCount: 2,
        holdCount: 0,
      },
      {
        localDay: sunday,
        status: 'PENDING_REVIEW' as const,
        chargeToman: null,
        chargeBytes: null,
        creditToman: null,
        netToman: null,
        entryCount: 0,
        holdCount: 2,
      },
    ];
    const [row] = groupShadowReportDays(
      data,
      'week',
      'SATURDAY',
      jalali(2026, 11, 1),
      jalali(2026, 11, 30),
    );
    expect(row).toMatchObject({
      status: 'PENDING_REVIEW',
      readyDays: 1,
      pendingDays: 1,
      readyChargeToman: '100000',
      readyCreditToman: '50000',
      readyNetToman: '50000',
      readyChargeBytes: '53687091200',
      chargeBytes: null,
      chargeToman: null,
      creditToman: null,
      netToman: null,
      entryCount: 2,
      holdCount: 2,
    });
    const month = groupShadowReportDays(
      data,
      'month',
      'SUNDAY',
      jalali(2026, 11, 1),
      jalali(2026, 11, 30),
    );
    // Saturday and Sunday here cross Aban/Azar: the hold is in the second month.
    expect(month).toHaveLength(2);
    expect(month[1]?.status).toBe('PENDING_REVIEW');
    expect(month[1]?.netToman).toBeNull();
  });

  it('uses integer signed net values and cannot silently count incomplete archive boundaries as final', () => {
    const day = jalali(2026, 11, 21);
    const [row] = groupShadowReportDays(
      [
        {
          localDay: day,
          status: 'SHADOW_READY',
          chargeToman: '0',
          chargeBytes: '0',
          creditToman: '9223372036854775807',
          netToman: '-9223372036854775807',
          entryCount: 1,
          holdCount: 0,
        },
      ],
      'week',
      'SATURDAY',
      day,
      day,
    );
    expect(row?.status).toBe('ARCHIVE_PARTIAL');
    expect(row?.netToman).toBeNull();
    expect(row?.readyNetToman).toBe('-9223372036854775807');
  });

  it('does not include adjacent Esfand/Farvardin dates in a Jalali monthly report', () => {
    const endEsfand = '1403-12-30';
    const farvardin = '1404-01-01';
    expect(shadowPeriodBounds(endEsfand, 'month', 'SATURDAY')).toEqual({
      start: '1403-12-01',
      end: endEsfand,
    });
    const data = [endEsfand, farvardin].map((localDay) => ({
      localDay,
      status: 'SHADOW_READY' as const,
      chargeToman: '5',
      chargeBytes: '5',
      creditToman: '0',
      netToman: '5',
      entryCount: 1,
      holdCount: 0,
    }));
    const monthly = groupShadowReportDays(
      data,
      'month',
      'MONDAY',
      '1403-01-01',
      '1404-12-29',
    );
    expect(monthly).toHaveLength(2);
    expect(monthly.map((x) => x.readyChargeToman)).toEqual(['5', '5']);
    expect(
      groupShadowReportDays(
        data,
        'month',
        'SATURDAY',
        '1403-01-01',
        '1404-12-29',
      ).map((x) => x.readyChargeToman),
    ).toEqual(['5', '5']);
  });

  it('fails closed on inconsistent posted or pending day values', () => {
    const day = '1405-08-30';
    expect(() =>
      groupShadowReportDays(
        [
          {
            localDay: day,
            status: 'SHADOW_READY',
            chargeToman: '100',
            chargeBytes: '50',
            creditToman: '10',
            netToman: '91',
            entryCount: 1,
            holdCount: 0,
          },
        ],
        'day',
        'SATURDAY',
        day,
        day,
      ),
    ).toThrow('SHADOW_DAY_AMOUNT_INTEGRITY_ERROR');
    expect(() =>
      groupShadowReportDays(
        [
          {
            localDay: day,
            status: 'PENDING_REVIEW',
            chargeToman: '0',
            chargeBytes: '0',
            creditToman: '0',
            netToman: '0',
            entryCount: 0,
            holdCount: 1,
          },
        ],
        'day',
        'SATURDAY',
        day,
        day,
      ),
    ).toThrow('SHADOW_PENDING_DAY_HAS_FINANCIAL_AMOUNT');
  });
});
