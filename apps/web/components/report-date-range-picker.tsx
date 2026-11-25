'use client';

import { useState } from 'react';
import type { CalendarDate } from '@fair-platform/calendar';
import {
  daysInReportMonth,
  formatReportDate,
  GREGORIAN_MONTHS,
  JALALI_MONTHS,
  parseReportDate,
  readableReportDate,
  reportToday,
  reportWeekday,
  shiftReportMonth,
  type ReportCalendar,
} from '../lib/report-calendar';

const WEEKDAYS = [
  { code: 'SUNDAY', label: 'ی' },
  { code: 'MONDAY', label: 'د' },
  { code: 'TUESDAY', label: 'س' },
  { code: 'WEDNESDAY', label: 'چ' },
  { code: 'THURSDAY', label: 'پ' },
  { code: 'FRIDAY', label: 'ج' },
  { code: 'SATURDAY', label: 'ش' },
] as const;

export function ReportDateRangePicker({
  calendar,
  timeZone,
  weekStart,
  from,
  to,
  onChange,
  archiveEnd,
}: {
  calendar: ReportCalendar;
  timeZone: string;
  weekStart: string;
  from: string;
  to: string;
  archiveEnd?: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<'from' | 'to'>('from');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [month, setMonth] = useState<CalendarDate>({
    year: 1405,
    month: 1,
    day: 1,
  });

  const openPicker = () => {
    const initial = from || to || archiveEnd || reportToday(calendar, timeZone);
    const parsed = parseReportDate(initial, calendar);
    setMonth({ ...parsed, day: 1 });
    setDraftFrom(from);
    setDraftTo(to);
    setEditing(from ? 'to' : 'from');
    setOpen(true);
  };
  const invalid = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const firstWeekday = reportWeekday({ ...month, day: 1 }, calendar);
  const firstIndex = WEEKDAYS.findIndex((day) => day.code === weekStart);
  const rotatedStart = firstIndex < 0 ? 6 : firstIndex;
  const emptyCells = (firstWeekday - rotatedStart + 7) % 7;
  const days = daysInReportMonth(month.year, month.month, calendar);
  const monthNames = calendar === 'jalali' ? JALALI_MONTHS : GREGORIAN_MONTHS;
  const years = Array.from(
    { length: 101 },
    (_, i) => month.year - 50 + i,
  ).filter(
    (year) =>
      year >= (calendar === 'jalali' ? 1 : 1) &&
      year <= (calendar === 'jalali' ? 3176 : 9999),
  );

  return (
    <div className="report-date-filter">
      <span className="report-filter-label">
        بازهٔ تاریخ ({calendar === 'jalali' ? 'شمسی' : 'میلادی'})
      </span>
      <button
        type="button"
        className="secondary report-date-trigger"
        onClick={openPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span>📅</span>
        <span>
          از {from ? readableReportDate(from, calendar) : 'ابتدای آرشیو'}
        </span>
        <span>تا {to ? readableReportDate(to, calendar) : 'انتهای آرشیو'}</span>
      </button>
      {open && (
        <div
          className="report-date-popover"
          role="dialog"
          aria-label="انتخاب بازهٔ تاریخ گزارش"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <div className="report-date-boundaries">
            {(['from', 'to'] as const).map((boundary) => (
              <button
                type="button"
                key={boundary}
                className={
                  editing === boundary ? 'report-date-selected' : 'secondary'
                }
                onClick={() => setEditing(boundary)}
                aria-pressed={editing === boundary}
              >
                <span>{boundary === 'from' ? 'از تاریخ' : 'تا تاریخ'}</span>
                <strong>
                  {(boundary === 'from' ? draftFrom : draftTo)
                    ? readableReportDate(
                        boundary === 'from' ? draftFrom : draftTo,
                        calendar,
                      )
                    : 'انتخاب نشده'}
                </strong>
              </button>
            ))}
          </div>
          <div className="report-date-navigation">
            <button
              type="button"
              className="secondary"
              aria-label="ماه قبل"
              onClick={() => setMonth(shiftReportMonth(month, -1))}
            >
              →
            </button>
            <select
              aria-label="ماه تقویم"
              value={month.month}
              onChange={(e) =>
                setMonth({ ...month, month: Number(e.target.value) })
              }
            >
              {monthNames.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="سال تقویم"
              value={month.year}
              onChange={(e) =>
                setMonth({ ...month, year: Number(e.target.value) })
              }
            >
              {years.map((year) => (
                <option value={year} key={year}>
                  {year.toLocaleString('fa-IR', { useGrouping: false })}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              aria-label="ماه بعد"
              onClick={() => setMonth(shiftReportMonth(month, 1))}
            >
              ←
            </button>
          </div>
          <div
            className="report-date-grid"
            role="group"
            aria-label="روزهای ماه"
          >
            {Array.from({ length: 7 }, (_, i) => (
              <b key={i}>{WEEKDAYS[(rotatedStart + i) % 7].label}</b>
            ))}
            {Array.from({ length: emptyCells }, (_, i) => (
              <span key={`empty-${i}`} />
            ))}
            {Array.from({ length: days }, (_, i) => {
              const value = formatReportDate({ ...month, day: i + 1 });
              const boundary = value === draftFrom || value === draftTo;
              const inRange =
                draftFrom && draftTo && value > draftFrom && value < draftTo;
              return (
                <button
                  type="button"
                  key={value}
                  className={
                    boundary
                      ? 'report-date-selected'
                      : inRange
                        ? 'report-date-in-range'
                        : 'secondary'
                  }
                  aria-label={readableReportDate(value, calendar)}
                  aria-pressed={Boolean(boundary)}
                  onClick={() => {
                    if (editing === 'from') {
                      setDraftFrom(value);
                      setEditing('to');
                    } else setDraftTo(value);
                  }}
                >
                  {(i + 1).toLocaleString('fa-IR')}
                </button>
              );
            })}
          </div>
          {invalid && (
            <p className="error-banner" role="alert">
              تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد.
            </p>
          )}
          <div className="report-date-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onChange('', '');
                setOpen(false);
              }}
            >
              کل بازهٔ آرشیو
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setOpen(false)}
            >
              لغو
            </button>
            <button
              type="button"
              disabled={invalid}
              onClick={() => {
                onChange(draftFrom, draftTo);
                setOpen(false);
              }}
            >
              اعمال بازه
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
