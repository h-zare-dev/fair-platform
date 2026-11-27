import {
  gregorianToJalali,
  isValidJalaliDate,
  jalaliToGregorian,
  type CalendarDate,
} from './index.js';

/** Calendar date only: no hours, offsets or host-local timezone implied. */
export function parseJalaliDate(text: string): CalendarDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new RangeError('INVALID_JALALI_DATE');
  const [year, month, day] = text.split('-').map(Number);
  const date = { year: year!, month: month!, day: day! };
  if (!isValidJalaliDate(date)) throw new RangeError('INVALID_JALALI_DATE');
  return date;
}

export function formatJalaliDate(date: CalendarDate): string {
  if (!isValidJalaliDate(date)) throw new RangeError('INVALID_JALALI_DATE');
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`;
}

export function validateTimeZone(zone: string): string {
  if (typeof zone !== 'string' || zone.length < 1 || zone.length > 100)
    throw new RangeError('INVALID_FAIR_TIME_ZONE');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
  } catch {
    throw new RangeError('INVALID_FAIR_TIME_ZONE');
  }
  return zone;
}

function gregorianDateAt(
  instant: Date,
  formatter: Intl.DateTimeFormat,
): CalendarDate {
  const parts = formatter.formatToParts(instant);
  const number = (type: 'year' | 'month' | 'day'): number => {
    const raw = parts.find((p) => p.type === type)?.value;
    if (!raw || !/^\d+$/.test(raw))
      throw new RangeError('INVALID_TIME_ZONE_DATE');
    return Number(raw);
  };
  return { year: number('year'), month: number('month'), day: number('day') };
}

// Intl.DateTimeFormat retains substantial native ICU state that is not counted
// against V8's heap limit. Recreating it for each archived event can exhaust
// the 512 MiB Staging API container even for a bounded 30-day replay.
// Keep the cache bounded because zones are also accepted from input.
const MAX_FORMATTERS = 16;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(zone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: validateTimeZone(zone),
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  if (dateFormatters.size >= MAX_FORMATTERS) {
    const first = dateFormatters.keys().next().value;
    if (first !== undefined) dateFormatters.delete(first);
  }
  dateFormatters.set(zone, formatter);
  return formatter;
}

function civilKey(d: CalendarDate): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

export function localJalaliDate(at: Date, zone: string): string {
  if (!Number.isFinite(at.getTime())) throw new RangeError('INVALID_INSTANT');
  return formatJalaliDate(
    gregorianToJalali(gregorianDateAt(at, formatterFor(zone))),
  );
}

/** UTC instant of the first moment belonging to this *local* calendar date.
 * Binary-searches local civil dates rather than adding 24 hours: this remains
 * correct across 23/25-hour DST days and local-midnight offset transitions.
 * A calendar date skipped by a historical dateline jump is rejected.
 */
export function jalaliLocalMidnightUtc(jalali: string, zone: string): string {
  const g = jalaliToGregorian(parseJalaliDate(jalali));
  const formatter = formatterFor(zone);
  const anchor = Date.UTC(g.year, g.month - 1, g.day);
  let lo = anchor - 3 * 86_400_000;
  let hi = anchor + 3 * 86_400_000;
  const target = civilKey(g);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (civilKey(gregorianDateAt(new Date(mid), formatter)) >= target) hi = mid;
    else lo = mid;
  }
  if (civilKey(gregorianDateAt(new Date(hi), formatter)) !== target)
    throw new RangeError('NONEXISTENT_LOCAL_DATE');
  return new Date(hi).toISOString();
}

/** Exact half-open UTC interval for inclusive Jalali end dates. */
export function jalaliValidityWindow(
  zone: string,
  start: string | null,
  end: string | null,
  now: Date = new Date(),
): {
  startDate: string;
  endDate: string | null;
  fromUtc: string;
  untilUtc: string | null;
  zone: string;
} {
  validateTimeZone(zone);
  const startDate =
    start === null
      ? localJalaliDate(now, zone)
      : formatJalaliDate(parseJalaliDate(start));
  const endDate = end === null ? null : formatJalaliDate(parseJalaliDate(end));
  if (endDate !== null && endDate < startDate)
    throw new RangeError('INVALID_DATE_WINDOW');
  const fromUtc = jalaliLocalMidnightUtc(startDate, zone);
  if (endDate === null)
    return { startDate, endDate, fromUtc, untilUtc: null, zone };
  const d = jalaliToGregorian(parseJalaliDate(endDate));
  const nextUtc = new Date(Date.UTC(d.year, d.month - 1, d.day) + 86_400_000);
  const next = formatJalaliDate(
    gregorianToJalali({
      year: nextUtc.getUTCFullYear(),
      month: nextUtc.getUTCMonth() + 1,
      day: nextUtc.getUTCDate(),
    }),
  );
  return {
    startDate,
    endDate,
    fromUtc,
    untilUtc: jalaliLocalMidnightUtc(next, zone),
    zone,
  };
}
