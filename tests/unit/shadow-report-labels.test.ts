import { describe, expect, it } from 'vitest';
import {
  isAnonymizedReplayName,
  jalaliMonthLabel,
  jalaliWeekLabel,
} from '../../apps/web/lib/shadow-report-labels.js';
import { archivedAdminNameStatus } from '../../apps/api/src/owner/application/archive-admin-name.js';

describe('SHADOW reports show exact Jalali periods and honest archive identities', () => {
  it('uses the complete Persian month name and year for the selected report', () => {
    expect(jalaliMonthLabel('1405-09-01')).toBe('آذر ۱۴۰۵');
    expect(jalaliMonthLabel('1404-12-01')).toBe('اسفند ۱۴۰۴');
    expect(jalaliMonthLabel('1405-13-01')).toBe('1405-13-01');
    expect(jalaliMonthLabel('invalid')).toBe('invalid');
  });

  it('shows both full week dates across Jalali month and year boundaries', () => {
    expect(jalaliWeekLabel('1405-12-29', '1406-01-05', 'SATURDAY')).toBe(
      'از شنبه ۱۴۰۵-۱۲-۲۹ تا جمعه ۱۴۰۶-۰۱-۰۵',
    );
    expect(jalaliWeekLabel('1405-09-01', '1405-09-07', 'SUNDAY')).toBe(
      'از یکشنبه ۱۴۰۵-۰۹-۰۱ تا شنبه ۱۴۰۵-۰۹-۰۷',
    );
    expect(jalaliWeekLabel('x', 'y', 'INVALID')).toBe('x تا y');
  });

  it('does not label pseudonymized names as real or verified', () => {
    expect(isAnonymizedReplayName('anon-493dca03dec5841')).toBe(true);
    expect(isAnonymizedReplayName('reseller')).toBe(false);
    expect(archivedAdminNameStatus(['anon-493dca03dec5841'], 'SOURCE')).toBe(
      'ARCHIVE_PSEUDONYMIZED',
    );
    expect(
      archivedAdminNameStatus(['anon-493dca03dec5841'], 'VERIFIED_IN_ARCHIVE'),
    ).toBe('ARCHIVE_PSEUDONYMIZED');
    expect(archivedAdminNameStatus(['real-admin'], 'SOURCE')).toBe('SOURCE');
    expect(archivedAdminNameStatus(['a', 'b'], 'SOURCE')).toBe('CONFLICT');
    expect(archivedAdminNameStatus(null, 'SOURCE')).toBe('MISSING');
  });
});
