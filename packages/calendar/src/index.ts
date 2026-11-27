import {
  isLeapJalaaliYear,
  isValidJalaaliDate,
  jalaaliMonthLength,
  toGregorian,
  toJalaali,
} from 'jalaali-js';

/** A civil date without a time of day or an implicit time zone. */
export type CalendarDate = Readonly<{
  year: number;
  month: number;
  day: number;
}>;

function isIntegerDate(date: CalendarDate): boolean {
  return (
    Number.isSafeInteger(date.year) &&
    Number.isSafeInteger(date.month) &&
    Number.isSafeInteger(date.day)
  );
}

/** Reject invalid inputs rather than allowing a date constructor to normalize them. */
export function isValidGregorianDate(date: CalendarDate): boolean {
  if (!isIntegerDate(date) || date.year < 1 || date.year > 9999) return false;
  if (date.month < 1 || date.month > 12) return false;

  const leap =
    date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return date.day >= 1 && date.day <= days[date.month - 1]!;
}

export function isValidJalaliDate(date: CalendarDate): boolean {
  if (!isIntegerDate(date) || date.year < 1) return false;
  try {
    return isValidJalaaliDate(date.year, date.month, date.day);
  } catch {
    // jalaali-js rejects unsupported years; never silently normalize them.
    return false;
  }
}

export function isJalaliLeapYear(year: number): boolean {
  if (!Number.isSafeInteger(year) || year < 1)
    throw new RangeError('INVALID_JALALI_YEAR');
  return isLeapJalaaliYear(year);
}

export function daysInJalaliMonth(year: number, month: number): number {
  if (!Number.isSafeInteger(month) || month < 1 || month > 12)
    throw new RangeError('INVALID_JALALI_MONTH');
  if (!Number.isSafeInteger(year) || year < 1)
    throw new RangeError('INVALID_JALALI_YEAR');
  return jalaaliMonthLength(year, month);
}

/** Convert civil Gregorian fields to Jalali; no UTC/local-day interpretation. */
export function gregorianToJalali(date: CalendarDate): CalendarDate {
  if (!isValidGregorianDate(date))
    throw new RangeError('INVALID_GREGORIAN_DATE');
  const result = toJalaali(date.year, date.month, date.day);
  return { year: result.jy, month: result.jm, day: result.jd };
}

/** Convert civil Jalali fields to Gregorian; invalid Esfand dates are rejected. */
export function jalaliToGregorian(date: CalendarDate): CalendarDate {
  if (!isValidJalaliDate(date)) throw new RangeError('INVALID_JALALI_DATE');
  const result = toGregorian(date.year, date.month, date.day);
  return { year: result.gy, month: result.gm, day: result.gd };
}
export * from './period.js';
