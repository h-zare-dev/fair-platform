'use client';

import { useState } from 'react';
import { formatGiB, formatInteger } from '../lib/traffic';

interface ReplayAudit {
  mode: 'HISTORICAL_STATIC_PACKAGE_PREVIEW';
  postingScope: 'NONE';
  completeAccounting: false;
  configurationReady: boolean;
  ingestionReady: boolean;
  packageCount: number;
  memberCount: number;
  assignedPackageCount: number;
  ingestedBatchCount: string;
  unfinishedBatchCount: string;
  normalizedEventCount: number;
  createEventCount: number;
  pricedCreateCount: number;
  heldCreateCount: number;
  createOnlySubtotalToman: string | null;
  unclassifiedEventCount: number;
  heldReasons: { code: string; count: number }[];
  actionCounts: { action: string; count: number }[];
  packageBreakdown: {
    packageBytes: string;
    durationDays: number;
    amountToman: string;
    pricedCreateCount: number;
    subtotalToman: string;
  }[];
}

export function ReplayAccountingPreview() {
  const [result, setResult] = useState<ReplayAudit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    if (busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch(
        '/api/v1/owner/operations/accounting/replay-preview',
        { cache: 'no-store', signal: AbortSignal.timeout(30000) },
      );
      if (response.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!response.ok)
        throw new Error(`بررسی آرشیو انجام نشد (HTTP ${response.status}).`);
      const data = (await response.json()) as ReplayAudit;
      if (
        data.mode !== 'HISTORICAL_STATIC_PACKAGE_PREVIEW' ||
        data.postingScope !== 'NONE' ||
        data.completeAccounting !== false
      )
        throw new Error('نتیجهٔ آزمایشی قابل تأیید نیست.');
      setResult(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'خطای نامشخص');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="table-card" aria-label="پیش‌نمایش حسابداری سی روزه">
      <div className="section-heading">
        <h2>تست حسابداری آرشیو ۳۰روزه</h2>
        <span className="badge">فقط شبیه‌سازی · بدون ثبت مالی</span>
      </div>
      <p className="muted">
        فرض این آزمایش: همان ۲۵ پکیج و قیمت‌های ثابت شش ماه اخیر برای همهٔ ۱۵۳
        مدیر معتبر بوده‌اند. مبلغ قابل‌محاسبهٔ Create جدا از Update، Reset و سایر
        عملیاتِ هنوز بررسی‌نشده نمایش داده می‌شود؛ این نتیجه صورت‌حساب نهایی
        نیست.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? 'در حال تطبیق داده‌ها…' : 'اجرای بررسی آزمایشی ۳۰روزه'}
      </button>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="catalog-source-panel">
          <p>
            پکیج‌ها: <b>{formatInteger(result.packageCount)}</b> · انتساب پکیج
            به گروه: <b>{formatInteger(result.assignedPackageCount)}</b> · اعضای
            گروه: <b>{formatInteger(result.memberCount)}</b>
          </p>
          <p>
            دریافت آرشیو:{' '}
            <b>{result.ingestionReady ? 'کامل' : 'نیازمند بررسی'}</b> (
            {formatInteger(result.ingestedBatchCount)} دسته،{' '}
            {formatInteger(result.unfinishedBatchCount)} دستهٔ ناتمام) · پوشش
            پکیج/گروه: <b>{result.configurationReady ? 'کامل' : 'ناقص'}</b>
          </p>
          <p>
            رویدادهای نرمال‌شده:{' '}
            <b>{formatInteger(result.normalizedEventCount)}</b> · Create:{' '}
            <b>{formatInteger(result.createEventCount)}</b> · Create قابل
            قیمت‌گذاری: <b>{formatInteger(result.pricedCreateCount)}</b> ·
            Create مبهم: <b>{formatInteger(result.heldCreateCount)}</b>
          </p>
          <p>
            <strong>جمع موقت فقط Create:</strong>{' '}
            {result.createOnlySubtotalToman === null
              ? 'محاسبه متوقف است؛ ابتدا پوشش آرشیو و پکیج‌ها باید کامل باشد.'
              : `${formatInteger(result.createOnlySubtotalToman)} تومان (غیرنهایی)`}
          </p>
          <p>
            <strong>رویدادهای خارج از محاسبهٔ Create:</strong>{' '}
            {formatInteger(result.unclassifiedEventCount)} مورد؛ هیچ‌کدام به‌طور
            خودکار صفر یا شارژشده فرض نشده‌اند.
          </p>
          {result.packageBreakdown.length > 0 && (
            <details>
              <summary>تطبیق جداگانهٔ قیمت و مبلغ هر ۲۵ پکیج</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>حجم</th>
                      <th>مدت</th>
                      <th>قیمت هر پکیج (تومان)</th>
                      <th>Create منطبق</th>
                      <th>جمع موقت (تومان)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.packageBreakdown.map((row) => (
                      <tr key={`${row.packageBytes}:${row.durationDays}`}>
                        <td>{formatGiB(row.packageBytes)}</td>
                        <td>{formatInteger(row.durationDays)} روز</td>
                        <td>{formatInteger(row.amountToman)}</td>
                        <td>{formatInteger(row.pricedCreateCount)}</td>
                        <td>{formatInteger(row.subtotalToman)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {result.heldReasons.length > 0 && (
            <details>
              <summary>دلایل توقف محاسبات Create</summary>
              <ul>
                {result.heldReasons.map((row) => (
                  <li key={row.code}>
                    <code>{row.code}</code>: {formatInteger(row.count)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary>تعداد عملیات به تفکیک نوع</summary>
            <ul>
              {result.actionCounts.map((row) => (
                <li key={row.action}>
                  <code>{row.action}</code>: {formatInteger(row.count)}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
