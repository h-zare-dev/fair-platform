'use client';

import { useEffect, useState } from 'react';
import { formatInteger } from '../lib/traffic';

type Status = {
  mode: 'OPENING_BASELINE_SHADOW';
  postingScope: 'NONE';
  financialCutoverReady: false;
  run: null | {
    id: string;
    status: string;
    phase: string;
    offset: number;
    sourceTotal: number | null;
    verifiedTotal: number | null;
    firstPassUsers: number;
    stable: number;
    changed: number;
    added: number;
    missing: number;
    unverified: number;
    unknownAdmin: number;
    unknownVolume: number;
    unknownExactDuration: number;
    failureCode: string | null;
  };
};

export function OpeningBaseline() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(
          '/api/v1/owner/operations/accounting/opening-baseline',
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (res.status === 401) {
          window.location.assign('/login');
          return;
        }
        if (res.status === 503) {
          setStatus(null);
          return;
        }
        if (!res.ok) throw new Error('گزارش وضعیت اولیه دریافت نشد.');
        const data = (await res.json()) as Status;
        if (
          data.mode !== 'OPENING_BASELINE_SHADOW' ||
          data.postingScope !== 'NONE' ||
          data.financialCutoverReady !== false
        )
          throw new Error('پاسخ واردسازی قابل تأیید نیست.');
        setStatus(data);
        if (
          ['PENDING', 'SCANNING', 'VERIFYING'].includes(data.run?.status ?? '')
        )
          timer = setTimeout(() => {
            void poll();
          }, 2500);
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
  }, [refresh]);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        '/api/v1/owner/operations/accounting/opening-baseline',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
          body: '{}',
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        },
      );
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok)
        throw new Error(`ثبت وضعیت اولیه شروع نشد (HTTP ${res.status}).`);
      setRefresh((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'خطای ارتباط');
    } finally {
      setBusy(false);
    }
  }

  const run = status?.run;
  const active = ['PENDING', 'SCANNING', 'VERIFYING'].includes(
    run?.status ?? '',
  );
  return (
    <section className="table-card" aria-label="ثبت وضعیت اولیه حسابداری">
      <div className="section-heading">
        <h2>FP-006: ثبت وضعیت اولیهٔ اکانت‌های موجود</h2>
        <span className="badge">فقط خواندن از پاسارگارد · بدون ثبت مالی</span>
      </div>
      <p className="muted">
        فهرست و وضعیت فعلی کاربران منبع اصلی در دو مرحله دریافت و تطبیق می‌شود.
        اکانت‌های موجود هیچ بدهی اولیه‌ای نمی‌سازند. تغییرات هنگام دریافت و
        اطلاعات ناقص گزارش می‌شوند؛ این تست مجوز شروع حسابداری واقعی یا جایگزین
        بررسی پوشش وب‌هوک نیست. مدت اصلی پکیج فعال از تاریخ انقضا حدس زده
        نمی‌شود.
      </p>
      {status && (
        <button
          className="secondary"
          type="button"
          onClick={() => void start()}
          disabled={busy || active}
        >
          {busy
            ? 'در حال شروع…'
            : run
              ? 'اجرای واردسازی جدید'
              : 'دریافت وضعیت اولیه از پاسارگارد'}
        </button>
      )}
      {!status && !error && (
        <p className="muted">
          دسترسی واردسازی فقط پس از فعال بودن منبع و SHADOW در دسترس است.
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {run && (
        <div className="catalog-source-panel" role="status">
          <p>
            وضعیت: <b>{run.status}</b> · مرحله: <b>{run.phase}</b> · شناسهٔ اجرا:{' '}
            <b>{run.id}</b>
          </p>
          <p>
            تعداد گزارش‌شده در منبع:{' '}
            <b>
              {run.sourceTotal == null ? '—' : formatInteger(run.sourceTotal)}
            </b>
            {' · '}ثبت اولیه: <b>{formatInteger(run.firstPassUsers)}</b>
            {' · '}تطبیق قطعی دو برداشت: <b>{formatInteger(run.stable)}</b>
          </p>
          <p>
            تغییرکرده در حین ثبت: <b>{formatInteger(run.changed)}</b>
            {' · '}افزوده‌شده: <b>{formatInteger(run.added)}</b>
            {' · '}حذف‌شده: <b>{formatInteger(run.missing)}</b>
          </p>
          <p>
            مالک نامشخص: <b>{formatInteger(run.unknownAdmin)}</b>
            {' · '}حجم نامشخص/نامحدود: <b>{formatInteger(run.unknownVolume)}</b>
            {' · '}مدت قابل اثبات از فیلد صریح On-hold ناموجود:{' '}
            <b>{formatInteger(run.unknownExactDuration)}</b>
          </p>
          {run.failureCode && (
            <p className="error-banner">علت توقف: {run.failureCode}</p>
          )}
          {run.status === 'COMPLETE' && (
            <p className="muted">
              دو برداشت پایان یافت. نتیجه فقط ثبت اولیهٔ آزمایشی است و هنوز برای
              قطعیت مالی و فعال‌سازی محاسبات شبانه تأیید نشده است.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
