'use client';

import { useEffect, useRef, useState } from 'react';
import { formatInteger } from '../lib/traffic';

type JournalStatus = {
  mode: 'HISTORICAL_SHADOW_LEDGER';
  postingScope: 'SHADOW';
  liveBalanceMutated: false;
  configuredDeleteCreditEnabled: boolean;
  run: null | {
    id: string;
    status: string;
    source: string;
    timeZone: string;
    correlationWindowSeconds: number;
    deleteCreditEnabled: boolean;
    eventCount: number;
    ignoredCount: number;
    entryCount: number;
    heldCount: number;
    heldCandidateCount: number;
    failureCode: string | null;
    readyDays: number;
    pendingDays: number;
    chargesToman: string;
    creditsToman: string;
    netToman: string;
    heldReasons: Array<{ code: string; count: number }>;
    packageTotals: Array<{
      packageId: string;
      kind: string;
      entryType: string;
      operationCount: number;
      totalToman: string;
    }>;
  };
};

export function ReplayShadowJournal() {
  const [status, setStatus] = useState<JournalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const pendingRequestKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          '/api/v1/owner/operations/accounting/replay-shadow',
          {
            signal: controller.signal,
            cache: 'no-store',
          },
        );
        if (response.status === 401) {
          window.location.assign('/login');
          return;
        }
        if (response.status === 503) return;
        if (!response.ok) throw new Error('گزارش دفتر آزمایشی دریافت نشد.');
        const result = (await response.json()) as JournalStatus;
        if (
          result.mode !== 'HISTORICAL_SHADOW_LEDGER' ||
          result.postingScope !== 'SHADOW' ||
          result.liveBalanceMutated !== false
        )
          throw new Error('وضعیت حسابداری آزمایشی قابل تأیید نیست.');
        setStatus(result);
        setError('');
        if (result.run?.status === 'PENDING')
          timer = setTimeout(() => void poll(), 2500);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'خطای ارتباط');
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [version]);

  async function start() {
    if (!status || busy || status.run?.status === 'PENDING') return;
    if (
      !window.confirm(
        'حسابداری آزمایشی آرشیو ۳۰روزه اجرا شود؟ این عملیات فقط دفتر SHADOW جدید می‌سازد؛ هیچ موجودی واقعی، وب‌هوک یا صورت‌حسابی تغییر نمی‌کند.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      pendingRequestKey.current ??= crypto.randomUUID();
      const response = await fetch(
        '/api/v1/owner/operations/accounting/replay-shadow',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
          cache: 'no-store',
          body: JSON.stringify({ requestKey: pendingRequestKey.current }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (response.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (response.status === 409)
        throw new Error(
          'آرشیو یا پوشش ۲۵ پکیج و ۱۵۳ مدیر کامل نیست، یا اجرای دیگری فعال است.',
        );
      if (!response.ok)
        throw new Error(
          `اجرای حسابداری آزمایشی آغاز نشد (HTTP ${response.status}).`,
        );
      pendingRequestKey.current = null;
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'خطای ارتباط');
    } finally {
      setBusy(false);
    }
  }

  const run = status?.run;
  return (
    <section className="table-card" aria-label="دفتر مالی آزمایشی آرشیو ۳۰روزه">
      <div className="section-heading">
        <h2>تست دفتر حسابداری آرشیو ۳۰روزه</h2>
        <span className="badge">فقط SHADOW · بدون تغییر موجودی واقعی</span>
      </div>
      <p className="muted">
        با همان ۲۵ قیمت ثابتِ تأییدشده، تراکنش‌های Create، Update، Reset و تمدید
        تحلیل می‌شوند. مدیران تاریخی فقط تحت فرض قیمت یکسان مالک ارزیابی
        می‌شوند؛ هویت آن‌ها با مدیران فعلی پاسارگارد معادل‌سازی نشده است. روزی
        که ابهام داشته باشد در انتظار بررسی می‌ماند و مبلغش در جمع قطعی محاسبه
        نمی‌شود. این آزمایش گزارش واقعی یا برداشت پول نیست.
      </p>
      {status && (
        <p className="muted" data-testid="replay-shadow-delete-policy">
          تنظیم فعلی ENV برای بستانکاری حذف اکانت:{' '}
          <b>{status.configuredDeleteCreditEnabled ? 'فعال' : 'غیرفعال'}</b>
          {' · '}هر اجرا تنظیم زمان آغاز خودش را حفظ می‌کند.
        </p>
      )}
      {status && (
        <button
          className="secondary"
          type="button"
          onClick={() => void start()}
          disabled={busy || run?.status === 'PENDING'}
        >
          {busy
            ? 'در حال آغاز…'
            : run?.status === 'PENDING'
              ? 'در حال محاسبه…'
              : run
                ? 'اجرای مجدد آزمون آفلاین'
                : 'اجرای آزمون آفلاین'}
        </button>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {run && (
        <div
          className="catalog-source-panel"
          role="status"
          data-testid="replay-shadow-summary"
        >
          <p>
            وضعیت: <b>{run.status}</b> · شناسهٔ اجرا: <b>{run.id}</b>
            {' · '}بستانکاری حذف در این اجرا:{' '}
            <b>{run.deleteCreditEnabled ? 'فعال' : 'غیرفعال'}</b>
          </p>
          {run.failureCode && (
            <p className="error-banner">کد توقف: {run.failureCode}</p>
          )}
          <p>
            رویدادهای بررسی‌شده: <b>{formatInteger(run.eventCount)}</b>
            {' · '}تراکنش‌های ثبت‌شده: <b>{formatInteger(run.entryCount)}</b>
            {' · '}ابهامات: <b>{formatInteger(run.heldCount)}</b>
            {' · '}عملیات بدون اثر مالی:{' '}
            <b>{formatInteger(run.ignoredCount)}</b>
          </p>
          <p>
            روزهای قابل‌محاسبه: <b>{formatInteger(run.readyDays)}</b>
            {' · '}روزهای منتظر بررسی: <b>{formatInteger(run.pendingDays)}</b>
            {' · '}تراکنش‌های متوقف‌شده همراه روز مبهم:{' '}
            <b>{formatInteger(run.heldCandidateCount)}</b>
          </p>
          <p>
            جمع بدهی SHADOW: <b>{formatInteger(run.chargesToman)}</b> تومان
            {' · '}جمع بستانکاری SHADOW:{' '}
            <b>{formatInteger(run.creditsToman)}</b> تومان
            {' · '}خالص آزمایشی: <b>{formatInteger(run.netToman)}</b> تومان
          </p>
          <details>
            <summary>دلایل توقف عملیات</summary>
            <ul>
              {run.heldReasons.map((reason) => (
                <li key={reason.code}>
                  {reason.code}: {formatInteger(reason.count)}
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>جمع تراکنش‌ها بر اساس پکیج و نوع عملیات</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>شناسه پکیج</th>
                    <th>عملیات</th>
                    <th>نوع سند</th>
                    <th>تعداد</th>
                    <th>مبلغ (تومان)</th>
                  </tr>
                </thead>
                <tbody>
                  {run.packageTotals.map((item) => (
                    <tr
                      key={`${item.packageId}:${item.kind}:${item.entryType}`}
                    >
                      <td>{item.packageId}</td>
                      <td>{item.kind}</td>
                      <td>{item.entryType}</td>
                      <td>{formatInteger(item.operationCount)}</td>
                      <td>{formatInteger(item.totalToman)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
