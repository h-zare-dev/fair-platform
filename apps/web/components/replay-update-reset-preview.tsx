'use client';

import { useState } from 'react';
import { formatGiB, formatInteger } from '../lib/traffic';

interface UpdateResetPreview {
  mode: 'HISTORICAL_UPDATE_RESET_PREVIEW';
  postingScope: 'NONE';
  completeAccounting: false;
  configurationReady: boolean;
  ingestionReady: boolean;
  correlationWindowSeconds: number;
  updateEventCount: number;
  resetEventCount: number;
  pairedRenewalCount: number;
  pairedResetContextCount: number;
  updateOnlyEventCount: number;
  resetOnlyEventCount: number;
  ambiguousUpdateCount: number;
  ambiguousResetCount: number;
  priorSnapshotMissingCount: number;
  boundaryFirstPairCount: number;
  pricedBoundaryFirstPairCount: number;
  pricedUpdateOnlyCount: number;
  pricedRenewalCount: number;
  pricedResetContextCount: number;
  pricedStandaloneResetCount: number;
  decreaseUpdateCount: number;
  unchangedUpdateCount: number;
  heldOperationCount: number;
  updateResetSubtotalToman: string | null;
  packageBreakdown: {
    packageBytes: string;
    durationDays: number;
    amountToman: string;
    pricedOperationCount: number;
    subtotalToman: string;
  }[];
  heldReasons: { code: string; count: number }[];
}

export function ReplayUpdateResetPreview() {
  const [result, setResult] = useState<UpdateResetPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const response = await fetch(
        '/api/v1/owner/operations/accounting/replay-update-reset-preview',
        { cache: 'no-store', signal: AbortSignal.timeout(30000) },
      );
      if (response.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!response.ok)
        throw new Error(
          `بررسی Update/Reset انجام نشد (HTTP ${response.status}).`,
        );
      const data = (await response.json()) as UpdateResetPreview;
      if (
        data.mode !== 'HISTORICAL_UPDATE_RESET_PREVIEW' ||
        data.postingScope !== 'NONE' ||
        data.completeAccounting !== false
      )
        throw new Error('پاسخ آزمایشی قابل تأیید نیست.');
      setResult(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'خطای نامشخص');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="table-card" aria-label="پیش‌نمایش آپدیت و ریست آرشیو">
      <div className="section-heading">
        <h2>تست ترکیبی FP-006 / FP-007: Update و Reset</h2>
        <span className="badge">فقط محاسبهٔ فرضی · بدون ثبت مالی</span>
      </div>
      <p className="muted">
        یک Reset به‌همراه Update معتبر، فقط یک تمدید با پکیج نهایی است؛ Update
        مستقل فقط افزایش مثبت حجم را محاسبه می‌کند. کاهش حجم بازپرداخت ندارد.
        Update بدون تغییر حجم هزینهٔ جدا ندارد؛ تنها اگر ارتباط یک‌به‌یک و حجم
        یکسان اثبات شود، می‌تواند مدت پکیج Reset را تأیید کند. همان ۲۵ نرخ ثابت
        اعلام‌شدهٔ مالک برای همهٔ مدیران آرشیو فرض شده‌اند. شناسه‌های آرشیو هنوز
        با مدیران واقعی تطبیق قطعی ندارند. Next Plan و تسویهٔ شبانه در این آزمایش
        محاسبه یا ثبت نمی‌شوند.
      </p>
      <button
        className="secondary"
        type="button"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? 'در حال بررسی رویدادها…' : 'اجرای بررسی ترکیبی Update و Reset'}
      </button>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="catalog-source-panel">
          <p>
            پوشش آرشیو: <b>{result.ingestionReady ? 'کامل' : 'ناقص'}</b> · پوشش
            پکیج‌ها: <b>{result.configurationReady ? 'کامل' : 'ناقص'}</b> · بازهٔ
            تطبیق: <b>{formatInteger(result.correlationWindowSeconds)} ثانیه</b>
          </p>
          <p>
            Update: <b>{formatInteger(result.updateEventCount)}</b> · Reset:{' '}
            <b>{formatInteger(result.resetEventCount)}</b> · جفت‌های تمدید یکتای
            بدون تکرار: <b>{formatInteger(result.pairedRenewalCount)}</b>
            {' · '}Reset با مدت مستند از Update:{' '}
            <b>{formatInteger(result.pairedResetContextCount)}</b>
          </p>
          <p>
            Update مستقل یا حل‌نشده:{' '}
            <b>{formatInteger(result.updateOnlyEventCount)}</b>
            {' · '}Reset مستقل یا حل‌نشده:{' '}
            <b>{formatInteger(result.resetOnlyEventCount)}</b>
            {' · '}تطبیق مبهم Update/Reset:{' '}
            <b>{formatInteger(result.ambiguousUpdateCount)}</b> /{' '}
            <b>{formatInteger(result.ambiguousResetCount)}</b>
          </p>
          <p>
            تطبیق یکتای Reset ابتدای آرشیو با Update بعدی:{' '}
            <b>{formatInteger(result.boundaryFirstPairCount)}</b>
            {' · '}از این جفت‌ها، دارای قیمت ثابت تأییدشده:{' '}
            <b>{formatInteger(result.pricedBoundaryFirstPairCount)}</b>
          </p>
          <p>
            تمدید دارای قیمت: <b>{formatInteger(result.pricedRenewalCount)}</b>
            {' · '}Reset با مدت تأییدشده و دارای قیمت:{' '}
            <b>{formatInteger(result.pricedResetContextCount)}</b>
            {' · '}Reset مستقل دارای قیمت:{' '}
            <b>{formatInteger(result.pricedStandaloneResetCount)}</b>
            {' · '}افزایش مستقل دارای قیمت:{' '}
            <b>{formatInteger(result.pricedUpdateOnlyCount)}</b>
          </p>
          <p>
            کاهش Update بدون هزینه:{' '}
            <b>{formatInteger(result.decreaseUpdateCount)}</b>
            {' · '}Update بدون تغییر حجم:{' '}
            <b>{formatInteger(result.unchangedUpdateCount)}</b>
            {' · '}عملیات نیازمند بررسی:{' '}
            <b>{formatInteger(result.heldOperationCount)}</b>
          </p>
          <p>
            <strong>جمع فقط فرضی Update و Reset:</strong>{' '}
            {result.updateResetSubtotalToman === null
              ? 'محاسبه متوقف است؛ آرشیو یا پکیج‌ها ناقص‌اند.'
              : `${formatInteger(result.updateResetSubtotalToman)} تومان (غیرنهایی)`}
          </p>
          <p className="muted">
            این عدد بدهی یا کردیت واقعی نیست؛ نتیجهٔ FP-005 Create جدا می‌ماند.
            فیلد مدت نامعتبر، رویداد نامطمئن یا ارتباط چندبه‌چند هرگز با قیمت
            پیش‌فرض محاسبه نمی‌شود. اگر مدت دو رویداد مرتبط تناقض داشته باشد،
            محاسبه تا بررسی متوقف می‌ماند. Reset آغاز آرشیو فقط زمانی با Update
            بعدی تطبیق داده می‌شود که یکتا، پشت‌سرهم و با زمان مرتب و دادهٔ منبع
            سازگار باشد؛ سابقهٔ قبلی فرض نمی‌شود.
          </p>
          {result.heldReasons.length > 0 && (
            <details>
              <summary>دلایل توقف محاسبهٔ Update/Reset</summary>
              <ul>
                {result.heldReasons.map((row) => (
                  <li key={row.code}>
                    <code>{row.code}</code>: {formatInteger(row.count)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.packageBreakdown.length > 0 && (
            <details>
              <summary>تعداد و مبلغ تمدیدها/افزایش‌ها به تفکیک ۲۵ پکیج</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>حجم</th>
                      <th>مدت</th>
                      <th>قیمت</th>
                      <th>عملیات دارای قیمت</th>
                      <th>جمع (تومان)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.packageBreakdown.map((row) => (
                      <tr key={`${row.packageBytes}:${row.durationDays}`}>
                        <td>{formatGiB(row.packageBytes)}</td>
                        <td>{formatInteger(row.durationDays)} روز</td>
                        <td>{formatInteger(row.amountToman)}</td>
                        <td>{formatInteger(row.pricedOperationCount)}</td>
                        <td>{formatInteger(row.subtotalToman)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
