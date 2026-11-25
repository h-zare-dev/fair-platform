import {
  daysInJalaliMonth,
  formatJalaliDate,
  gregorianToJalali,
  isValidGregorianDate,
  jalaliToGregorian,
  parseJalaliDate,
  type CalendarDate,
} from '@fair-platform/calendar';
import { jalaliMonthLabel } from './shadow-report-labels';

export type ReportCalendar = 'jalali' | 'gregorian';

export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
] as const;
export const GREGORIAN_MONTHS = [
  'ژانویه',
  'فوریه',
  'مارس',
  'آوریل',
  'مه',
  'ژوئن',
  'ژوئیه',
  'اوت',
  'سپتامبر',
  'اکتبر',
  'نوامبر',
  'دسامبر',
] as const;

export function formatReportDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function parseReportDate(
  value: string,
  calendar: ReportCalendar,
): CalendarDate {
  if (calendar === 'jalali') return parseJalaliDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new RangeError('INVALID_REPORT_DATE');
  const [year, month, day] = value.split('-').map(Number);
  const date = {
    year: year ?? Number.NaN,
    month: month ?? Number.NaN,
    day: day ?? Number.NaN,
  };
  if (!isValidGregorianDate(date)) throw new RangeError('INVALID_REPORT_DATE');
  return date;
}

export function daysInReportMonth(
  year: number,
  month: number,
  calendar: ReportCalendar,
): number {
  if (calendar === 'jalali') return daysInJalaliMonth(year, month);
  if (
    !Number.isSafeInteger(year) ||
    year < 1 ||
    year > 9999 ||
    !Number.isSafeInteger(month) ||
    month < 1 ||
    month > 12
  )
    throw new RangeError('INVALID_REPORT_MONTH');
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function reportDateFromJalali(
  value: string,
  calendar: ReportCalendar,
): string {
  const jalali = parseJalaliDate(value);
  return calendar === 'jalali'
    ? value
    : formatReportDate(jalaliToGregorian(jalali));
}

export function reportDateToJalali(
  value: string,
  calendar: ReportCalendar,
): string {
  const date = parseReportDate(value, calendar);
  return calendar === 'jalali'
    ? formatJalaliDate(date)
    : formatJalaliDate(gregorianToJalali(date));
}

export function reportMonthLabel(
  start: string,
  calendar: ReportCalendar,
): string {
  if (calendar === 'jalali') return jalaliMonthLabel(start);
  const { year, month } = parseReportDate(start, calendar);
  return `${GREGORIAN_MONTHS[month - 1]} ${year.toLocaleString('fa-IR', { useGrouping: false })}`;
}

export function readableReportDate(
  value: string,
  calendar: ReportCalendar,
): string {
  const { year, month, day } = parseReportDate(value, calendar);
  const monthName =
    calendar === 'jalali'
      ? JALALI_MONTHS[month - 1]
      : GREGORIAN_MONTHS[month - 1];
  return `${day.toLocaleString('fa-IR')} ${monthName} ${year.toLocaleString('fa-IR', { useGrouping: false })}`;
}

export function reportWeekday(
  date: CalendarDate,
  calendar: ReportCalendar,
): number {
  const gregorian = calendar === 'jalali' ? jalaliToGregorian(date) : date;
  return new Date(
    Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day),
  ).getUTCDay();
}

export function shiftReportMonth(
  date: CalendarDate,
  offset: number,
): CalendarDate {
  const zeroBased = date.year * 12 + date.month - 1 + offset;
  const year = Math.floor(zeroBased / 12);
  return { year, month: zeroBased - year * 12 + 1, day: 1 };
}

/** The run's time zone, not the viewer's browser zone, determines "today". */
export function reportToday(
  calendar: ReportCalendar,
  timeZone: string,
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const number = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const gregorian = {
    year: number('year'),
    month: number('month'),
    day: number('day'),
  };
  return calendar === 'jalali'
    ? formatJalaliDate(gregorianToJalali(gregorian))
    : formatReportDate(gregorian);
}

/** Presentation only. Audit timestamps remain immutable UTC instants. */
export function formatReportInstant(
  iso: string,
  calendar: ReportCalendar,
  timeZone: string,
): string {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return 'زمان نامعتبر';
  return `${new Intl.DateTimeFormat(
    calendar === 'jalali' ? 'fa-IR-u-ca-persian' : 'fa-IR-u-ca-gregory',
    {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
  ).format(instant)} (${timeZone})`;
}
