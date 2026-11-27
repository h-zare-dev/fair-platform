'use client';

import { useEffect, useRef, useState } from 'react';
import { formatInteger } from '../lib/traffic';

type Status = {
  mode: 'OPENING_BASELINE_SHADOW';
  postingScope: 'NONE';
  financialCutoverReady: false;
  cutoverLocked: boolean;
  generation: number;
  run: null | {
    id: string;
    status: string;
    phase: string;
    offset: number;
    sourceTotal: number | null;
    verifiedTotal: number | null;
    firstPassUsers: number;
    stable: number;
    nonMaterialChanged: number;
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
  const pendingRequestKey = useRef<string | null>(null);
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
    if (
      !window.confirm(
        status?.run
          ? 'واردسازی فعلی از حالت فعال خارج می‌شود و فهرست جدید کاملاً از صفر دریافت خواهد شد. سوابق قبلی برای ممیزی باقی می‌مانند؛ پکیج‌ها، گروه‌ها و رویدادها پاک نمی‌شوند. تأیید می‌کنید؟'
          : 'دریافت وضعیت اولیه از پاسارگارد آغاز شود؟ این عملیات هیچ بدهی یا کردیتی ثبت نمی‌کند.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      pendingRequestKey.current ??= crypto.randomUUID();
      const res = await fetch(
        '/api/v1/owner/operations/accounting/opening-baseline/reseed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
          body: JSON.stringify({ requestKey: pendingRequestKey.current }),
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        },
      );
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (res.status === 409)
        throw new Error(
          'واردسازی هم‌زمان فعال است یا شروع حسابداری، بازنشانی را قفل کرده است.',
        );
      if (!res.ok)
        throw new Error(`ثبت وضعیت اولیه شروع نشد (HTTP ${res.status}).`);
      pendingRequestKey.current = null;
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
        <h2>ثبت وضعیت اولیهٔ اکانت‌های موجود</h2>
        <span className="badge">فقط خواندن از پاسارگارد · بدون ثبت مالی</span>
      </div>
      <p className="muted">
        فهرست و وضعیت فعلی کاربران منبع اصلی در دو مرحله دریافت و تطبیق می‌شود.
        مرحلهٔ دوم شناسه‌های ثبت‌شده در مرحلهٔ اول را بررسی می‌کند؛ اکانت‌های جدید
        پس از مرحلهٔ اول به این فهرست اضافه نمی‌شوند. تغییر تعداد اکانت‌های زنده
        مانع اتمام بررسی نمی‌شود، اما پوشش کامل منبع را هم اثبات نمی‌کند.
        اکانت‌های موجود هیچ بدهی اولیه‌ای نمی‌سازند. تغییرات هنگام دریافت و
        اطلاعات ناقص گزارش می‌شوند؛ این تست مجوز شروع حسابداری واقعی یا جایگزین
        بررسی پوشش وب‌هوک نیست. مدت اصلی پکیج فعال از تاریخ انقضا حدس زده
        نمی‌شود.
      </p>
      {status && (
        <p className="muted" data-testid="baseline-generation">
          نسل واردسازی انتخاب‌شده: <b>{formatInteger(status.generation)}</b>
          {' · '}سوابق نسل‌های قبلی حفظ می‌شوند، اما وارد محاسبات نسل تازه
          نمی‌شوند.
        </p>
      )}
      {status && (
        <button
          className="secondary"
          type="button"
          onClick={() => void start()}
          disabled={busy || active || status.cutoverLocked}
        >
          {busy
            ? 'در حال شروع…'
            : run
              ? 'بازنشانی و دریافت مجدد'
              : 'دریافت وضعیت اولیه از پاسارگارد'}
        </button>
      )}
      {status?.cutoverLocked && (
        <p role="alert" className="error-banner">
          پس از شروع حسابداری مالی، بازنشانی وضعیت اولیه مجاز نیست.
        </p>
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
            {' · '}بدون تغییر مهم در دو برداشت:{' '}
            <b>{formatInteger(run.stable)}</b>
          </p>
          <p>
            تغییر در وضعیت/پکیج/مالک: <b>{formatInteger(run.changed)}</b>
            {' · '}تغییر فقط در مصرف یا زمان ویرایش:{' '}
            <b>{formatInteger(run.nonMaterialChanged)}</b>
            {' · '}حذف‌شده: <b>{formatInteger(run.missing)}</b>
          </p>
          {run.sourceTotal != null && run.verifiedTotal != null && (
            <p className="muted">
              تعداد منبع در اولین برداشت:{' '}
              <b>{formatInteger(run.sourceTotal)}</b>
              {' · '}آخرین تعداد مشاهده‌شده:{' '}
              <b>{formatInteger(run.verifiedTotal)}</b>
              {' · '}تغییر خالص تعداد:{' '}
              <b>{formatInteger(run.verifiedTotal - run.sourceTotal)}</b>
              {' (تعداد دقیق ایجاد و حذف را نشان نمی‌دهد)'}
            </p>
          )}
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
              تطبیق شناسه‌های برداشت اول پایان یافت. اکانت‌های ساخته‌شده پس از
              برداشت اول باید با پوشش وب‌هوک‌ها جداگانه آشتی داده شوند؛ این
              نتیجه فقط آزمایشی است و مجوز محاسبات مالی نیست.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
