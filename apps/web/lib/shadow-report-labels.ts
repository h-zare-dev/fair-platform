/** Human-readable labels for the already-calculated Jalali report boundaries. */
const MONTH_NAMES = [
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

const WEEKDAY_NAMES = [
  'شنبه',
  'یکشنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنجشنبه',
  'جمعه',
] as const;

const WEEK_STARTS = [
  'SATURDAY',
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
] as const;

const persianDate = (value: string) =>
  value.replace(/\d/g, (digit) => String.fromCharCode(0x06f0 + Number(digit)));

export function jalaliMonthLabel(start: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(start);
  if (!match) return start;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return start;
  return `${MONTH_NAMES[month - 1]} ${Number(match[1]).toLocaleString('fa-IR', { useGrouping: false })}`;
}

export function jalaliWeekLabel(
  start: string,
  end: string,
  configuredWeekStart: string,
): string {
  const index = WEEK_STARTS.indexOf(
    configuredWeekStart as (typeof WEEK_STARTS)[number],
  );
  if (index < 0) return `${start} تا ${end}`;
  return `از ${WEEKDAY_NAMES[index]} ${persianDate(start)} تا ${WEEKDAY_NAMES[(index + 6) % 7]} ${persianDate(end)}`;
}

/** The replay file deliberately replaced original names with opaque aliases. */
export function isAnonymizedReplayName(name: string): boolean {
  return /^anon-[0-9a-f]{8,64}$/i.test(name);
}
