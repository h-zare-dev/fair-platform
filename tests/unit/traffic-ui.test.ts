import { describe, expect, it } from 'vitest';
import {
  asciiDigits,
  fixedCatalogGiB,
  fixedRowsToCatalog,
  formatGiB,
  formatUtc,
  gibToBytes,
} from '../../apps/web/lib/traffic.js';

describe('Owner UI: GiB input/output is exact at the API boundary', () => {
  it('accepts Persian and Arabic numerals and converts 50 GiB exactly', () => {
    expect(gibToBytes('۵۰')).toBe('53687091200');
    expect(gibToBytes('۰۵۰')).toBe('53687091200');
    expect(gibToBytes('٥٠')).toBe('53687091200');
    expect(asciiDigits('۱۲٫۵')).toBe('12.5');
    expect(gibToBytes('1.5')).toBe('1610612736');
    expect(gibToBytes('۰٫۱۲۵')).toBe('134217728');
  });

  it('never silently rounds a fractional GiB to an inexact byte count', () => {
    for (const value of ['0.1', '0', '-1', 'NaN', '1e3', '1.2.3'])
      expect(() => gibToBytes(value)).toThrow();
    expect(() => gibToBytes('8589934592')).toThrow();
  });

  it('maps fixed package catalogs from GiB to exact byte keys and Toman strings', () => {
    expect(fixedCatalogGiB('۵۰:۱۵۰۰۰۰\n100:270000')).toEqual({
      '53687091200': '150000',
      '107374182400': '270000',
    });
    expect(fixedCatalogGiB('1:100، 2:180')).toEqual({
      '1073741824': '100',
      '2147483648': '180',
    });
    expect(() => fixedCatalogGiB('1:100, ۱:200')).toThrow(/تکراری/);
    expect(() => fixedCatalogGiB('0.1:100')).toThrow(/صحیح بایت/);
    expect(() => fixedCatalogGiB('50:-100')).toThrow(/قیمت/);
    expect(() => fixedCatalogGiB('50:100,')).toThrow();
  });

  it('converts separate GiB/Toman fields and rejects partial fixed-package rows', () => {
    expect(
      fixedRowsToCatalog([
        { gib: '۵۰', toman: '۱۵۰٬۰۰۰' },
        { gib: '100', toman: '270000' },
      ]),
    ).toEqual({
      '53687091200': '150000',
      '107374182400': '270000',
    });
    expect(() => fixedRowsToCatalog([{ gib: '50', toman: '' }])).toThrow(
      /تکمیل/,
    );
    expect(() => fixedRowsToCatalog([{ gib: '', toman: '' }])).toThrow(/حداقل/);
    expect(fixedRowsToCatalog([{ gib: '', toman: '' }], true)).toEqual({});
  });

  it('shows event limits and fixed packages in GiB, not raw bytes', () => {
    expect(formatGiB('53687091200')).toBe('۵۰ گیگابایت');
    expect(formatGiB('1610612736')).toBe('۱٫۵ گیگابایت');
    expect(formatGiB('0')).toBe('۰ گیگابایت');
    expect(formatGiB('500000000')).toMatch(/^حدود .* گیگابایت$/);
    expect(formatGiB('1')).toBe('کمتر از ۰٫۰۰۰۰۰۱ گیگابایت');
    expect(formatGiB('invalid')).toBe('—');
  });

  it('keeps UTC seconds visible for operational event ordering', () => {
    const formatted = formatUtc('2026-11-18T12:34:05Z');
    expect(formatted).toContain('UTC');
    expect(formatted).toContain('۰۵');
  });
});
