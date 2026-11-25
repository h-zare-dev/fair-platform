import {
  daysInJalaliMonth,
  formatJalaliDate,
  gregorianToJalali,
  isValidGregorianDate,
  jalaliToGregorian,
  parseJalaliDate,
} from '@fair-platform/calendar';

export const WEEK_DAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;
export type ReportWeekStart = (typeof WEEK_DAYS)[number];
export type ReportPeriod = 'day' | 'week' | 'month';
export type ReportCalendar = 'jalali' | 'gregorian';

export function parseReportCalendar(raw: string = 'jalali'): ReportCalendar {
  const normalized = raw.toLowerCase();
  if (normalized !== 'jalali' && normalized !== 'gregorian')
    throw new RangeError('INVALID_REPORT_CALENDAR');
  return normalized;
}

function parseGregorianDate(raw: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw))
    throw new RangeError('INVALID_GREGORIAN_DATE');
  const [year, month, day] = raw.split('-').map(Number);
  const date = { year: year!, month: month!, day: day! };
  if (!isValidGregorianDate(date))
    throw new RangeError('INVALID_GREGORIAN_DATE');
  return date;
}

function gregorianString(date: { year: number; month: number; day: number }) {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function reportDateToJalali(
  date: string,
  calendar: ReportCalendar,
): string {
  if (calendar === 'jalali') return formatJalaliDate(parseJalaliDate(date));
  return formatJalaliDate(gregorianToJalali(parseGregorianDate(date)));
}

export function jalaliToReportDate(
  date: string,
  calendar: ReportCalendar,
): string {
  if (calendar === 'jalali') return formatJalaliDate(parseJalaliDate(date));
  return gregorianString(jalaliToGregorian(parseJalaliDate(date)));
}

export function parseReportWeekStart(
  raw: string = 'SATURDAY',
): ReportWeekStart {
  const normalized = raw.toUpperCase();
  if (!(WEEK_DAYS as readonly string[]).includes(normalized))
    throw new RangeError('INVALID_REPORT_WEEK_START_DAY');
  return normalized as ReportWeekStart;
}

function utcGregorian(date: string): Date {
  const g = jalaliToGregorian(parseJalaliDate(date));
  return new Date(Date.UTC(g.year, g.month - 1, g.day));
}

function addJalaliDays(date: string, delta: number): string {
  const utc = utcGregorian(date);
  utc.setUTCDate(utc.getUTCDate() + delta);
  return formatJalaliDate(
    gregorianToJalali({
      year: utc.getUTCFullYear(),
      month: utc.getUTCMonth() + 1,
      day: utc.getUTCDate(),
    }),
  );
}

function addGregorianDays(date: string, delta: number): string {
  const g = parseGregorianDate(date);
  const utc = new Date(Date.UTC(g.year, g.month - 1, g.day + delta));
  return gregorianString({
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  });
}

export function shadowPeriodBounds(
  localDay: string,
  period: ReportPeriod,
  weekStart: ReportWeekStart,
  calendar: ReportCalendar = 'jalali',
): { start: string; end: string } {
  const day = parseJalaliDate(localDay);
  const displayDay = jalaliToReportDate(localDay, calendar);
  if (period === 'day') return { start: displayDay, end: displayDay };
  if (period === 'month') {
    if (calendar === 'gregorian') {
      const gregorian = parseGregorianDate(displayDay);
      const end = new Date(Date.UTC(gregorian.year, gregorian.month, 0));
      return {
        start: gregorianString({ ...gregorian, day: 1 }),
        end: gregorianString({ ...gregorian, day: end.getUTCDate() }),
      };
    }
    return {
      start: formatJalaliDate({ ...day, day: 1 }),
      end: formatJalaliDate({
        ...day,
        day: daysInJalaliMonth(day.year, day.month),
      }),
    };
  }
  const offset =
    (utcGregorian(localDay).getUTCDay() - WEEK_DAYS.indexOf(weekStart) + 7) % 7;
  if (calendar === 'gregorian') {
    const start = addGregorianDays(displayDay, -offset);
    return { start, end: addGregorianDays(start, 6) };
  }
  const start = addJalaliDays(localDay, -offset);
  return { start, end: addJalaliDays(start, 6) };
}

export interface StoredShadowDay {
  localDay: string;
  /** Rows may represent several administrators with the same day/status. */
  adminDays?: number;
  status: 'SHADOW_READY' | 'PENDING_REVIEW';
  chargeToman: string | null;
  chargeBytes: string | null;
  creditToman: string | null;
  netToman: string | null;
  entryCount: number;
  holdCount: number;
}

export interface ShadowPeriodRow {
  startDate: string;
  endDate: string;
  status: 'RECONCILED' | 'PENDING_REVIEW' | 'ARCHIVE_PARTIAL';
  observedDays: number;
  readyDays: number;
  pendingDays: number;
  entryCount: number;
  holdCount: number;
  /** Ready-only subtotal, not a final amount when status is not RECONCILED. */
  readyChargeToman: string;
  readyCreditToman: string;
  readyNetToman: string;
  readyChargeBytes: string | null;
  chargeBytes: string | null;
  chargeToman: string | null;
  creditToman: string | null;
  netToman: string | null;
}

export function groupShadowReportDays(
  days: readonly StoredShadowDay[],
  period: ReportPeriod,
  weekStart: ReportWeekStart,
  archiveFrom: string | null,
  archiveTo: string | null,
  calendar: ReportCalendar = 'jalali',
): ShadowPeriodRow[] {
  const groups = new Map<
    string,
    { bounds: { start: string; end: string }; days: StoredShadowDay[] }
  >();
  for (const day of days) {
    const bounds = shadowPeriodBounds(
      day.localDay,
      period,
      weekStart,
      calendar,
    );
    const group = groups.get(bounds.start) ?? { bounds, days: [] };
    group.days.push(day);
    groups.set(bounds.start, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.bounds.start.localeCompare(b.bounds.start))
    .map(({ bounds, days: records }) => {
      let charges = 0n;
      let chargeBytes = 0n;
      let volumeKnown = true;
      let credits = 0n;
      let readyDays = 0;
      let pendingDays = 0;
      let entryCount = 0;
      let holdCount = 0;
      let observedDays = 0;
      for (const row of records) {
        const adminDays = row.adminDays ?? 1;
        if (!Number.isSafeInteger(adminDays) || adminDays < 1)
          throw new RangeError('INVALID_REPORT_ADMIN_DAY_COUNT');
        observedDays += adminDays;
        holdCount += row.holdCount;
        if (row.status === 'PENDING_REVIEW') {
          if (
            row.chargeToman !== null ||
            row.creditToman !== null ||
            row.netToman !== null ||
            row.entryCount !== 0 ||
            row.holdCount === 0
          )
            throw new Error('SHADOW_PENDING_DAY_HAS_FINANCIAL_AMOUNT');
          pendingDays += adminDays;
        } else {
          if (
            row.chargeToman === null ||
            row.creditToman === null ||
            row.netToman === null ||
            BigInt(row.chargeToman) - BigInt(row.creditToman) !==
              BigInt(row.netToman) ||
            row.holdCount !== 0
          )
            throw new Error('SHADOW_DAY_AMOUNT_INTEGRITY_ERROR');
          charges += BigInt(row.chargeToman);
          if (row.chargeBytes === null) volumeKnown = false;
          else chargeBytes += BigInt(row.chargeBytes);
          credits += BigInt(row.creditToman);
          entryCount += row.entryCount;
          readyDays += adminDays;
        }
      }
      const status: ShadowPeriodRow['status'] =
        pendingDays > 0
          ? 'PENDING_REVIEW'
          : !archiveFrom ||
              !archiveTo ||
              bounds.start < jalaliToReportDate(archiveFrom, calendar) ||
              bounds.end > jalaliToReportDate(archiveTo, calendar)
            ? 'ARCHIVE_PARTIAL'
            : 'RECONCILED';
      const net = charges - credits;
      return {
        startDate: bounds.start,
        endDate: bounds.end,
        status,
        observedDays,
        readyDays,
        pendingDays,
        entryCount,
        holdCount,
        readyChargeToman: charges.toString(),
        readyCreditToman: credits.toString(),
        readyNetToman: net.toString(),
        readyChargeBytes: volumeKnown ? chargeBytes.toString() : null,
        chargeBytes:
          volumeKnown && status === 'RECONCILED'
            ? chargeBytes.toString()
            : null,
        chargeToman: status === 'RECONCILED' ? charges.toString() : null,
        creditToman: status === 'RECONCILED' ? credits.toString() : null,
        netToman: status === 'RECONCILED' ? net.toString() : null,
      };
    });
}
