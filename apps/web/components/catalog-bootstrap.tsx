'use client';

import { useState } from 'react';
import { asciiDigits, formatGiB, formatInteger } from '../lib/traffic';

type Shape = { name: string; packageBytes: string; durationDays: number };
type Requirements = {
  sourceInstanceId: 'primary';
  expectedAdmins: number;
  packages: Shape[];
  pricesRequired: true;
  postingScope: 'NONE';
};
type CatalogState = {
  groups: unknown[];
  memberships: unknown[];
  packages: unknown[];
  assignments: unknown[];
};
type BootstrapResult = {
  sourceInstanceId: 'primary';
  packageCount: number;
  groupCount: number;
  memberCount: number;
  assignedPackageCount: number;
};
const MAX_TOMAN = 9223372036854775807n;

export function CatalogBootstrap() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const [occupied, setOccupied] = useState(false);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BootstrapResult | null>(null);

  async function expand() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (requirements) return;
    setLoading(true);
    setError('');
    try {
      const [catalogResponse, reqResponse] = await Promise.all([
        fetch('/api/v1/owner/catalog/config?source=primary', {
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        }),
        fetch('/api/v1/owner/catalog/bootstrap/requirements', {
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        }),
      ]);
      if (catalogResponse.status === 401 || reqResponse.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!catalogResponse.ok || !reqResponse.ok)
        throw new Error(
          `دریافت مشخصات پکیج‌ها انجام نشد (HTTP ${!catalogResponse.ok ? catalogResponse.status : reqResponse.status}).`,
        );
      const [catalog, req] = await Promise.all([
        catalogResponse.json() as Promise<CatalogState>,
        reqResponse.json() as Promise<Requirements>,
      ]);
      if (
        req.sourceInstanceId !== 'primary' ||
        req.packages.length !== 25 ||
        req.pricesRequired !== true ||
        req.postingScope !== 'NONE'
      )
        throw new Error('فهرست مرجع ۲۵ پکیج قابل تأیید نیست.');
      setOccupied(
        catalog.groups.length > 0 ||
          catalog.packages.length > 0 ||
          catalog.memberships.length > 0 ||
          catalog.assignments.length > 0,
      );
      setRequirements(req);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'خطای نامشخص');
    } finally {
      setLoading(false);
    }
  }

  const allPrices =
    requirements?.packages.every(({ name }) => {
      const value = asciiDigits(prices[name] ?? '');
      return /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_TOMAN;
    }) ?? false;

  async function submit() {
    if (!requirements || !confirmed || !allPrices || occupied || busy || result)
      return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/owner/catalog/bootstrap', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
        body: JSON.stringify({
          confirmation: 'CONFIRM_25_PACKAGES_153_ADMINS',
          prices: requirements.packages.map(({ name }) => ({
            name,
            amountToman: asciiDigits(prices[name] ?? ''),
          })),
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (response.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!response.ok) {
        if (response.status === 409)
          throw new Error(
            'پکیج‌ها قبلاً تنظیم شده‌اند یا اطلاعات هم‌زمان تغییر کرده است. هیچ موردی بازنویسی نشد.',
          );
        if (response.status === 503)
          throw new Error(
            'دایرکتوری ۱۵۳ ادمین در دسترس نیست یا تعداد آن تغییر کرده؛ هیچ چیزی ثبت نشد.',
          );
        throw new Error(
          `ثبت یکجای پکیج‌ها انجام نشد (HTTP ${response.status}).`,
        );
      }
      const created = (await response.json()) as BootstrapResult;
      if (
        created.packageCount !== 25 ||
        created.memberCount !== 153 ||
        created.assignedPackageCount !== 25
      )
        throw new Error(
          'نتیجهٔ ثبت با تعداد مورد انتظار یکسان نیست؛ وضعیت را دوباره بررسی کنید.',
        );
      setResult(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'خطای نامشخص');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="table-card"
      aria-label="راه‌اندازی یکجای پکیج‌ها و مدیران"
    >
      <div className="section-heading">
        <h2>ثبت یکجای ۲۵ پکیج برای ۱۵۳ مدیر</h2>
        <span className="badge">فقط با تأیید مالک · بدون ثبت مالی</span>
      </div>
      <p className="muted">
        ابتدا ۲۵ قیمت واقعی و تأییدشده را وارد کنید. با یک تأیید، ۲۵ پکیج، یک
        گروه مشترک، عضویت همهٔ ۱۵۳ مدیر و ۲۵ اختصاص گروهی به‌صورت یکپارچه ذخیره
        می‌شود. هیچ قیمت پیش‌فرض یا تخمینی وجود ندارد.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => void expand()}
        disabled={loading || busy}
      >
        {open ? 'بستن فرم ثبت' : 'باز کردن فرم قیمت‌های ۲۵ پکیج'}
      </button>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="catalog-source-panel">
          ثبت انجام شد: {formatInteger(result.packageCount)} پکیج،{' '}
          {formatInteger(result.memberCount)} مدیر و{' '}
          {formatInteger(result.assignedPackageCount)} انتساب گروهی. حالا تست
          حسابداری ۳۰روزه را دوباره اجرا کنید.
        </p>
      )}
      {open && !result && (
        <div className="catalog-source-panel">
          {loading && <p>در حال دریافت مشخصات مرجع…</p>}
          {occupied && (
            <p role="alert">
              پکیج‌ها یا گروه‌ها از قبل تنظیم شده‌اند. برای حفظ داده‌ها، ثبت
              یکجای جدید مسدود است.
            </p>
          )}
          {requirements && !occupied && (
            <>
              <p>
                تعداد مدیران مورد انتظار:{' '}
                {formatInteger(requirements.expectedAdmins)} · مبلغ همهٔ پکیج‌ها
                به تومان
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>نام پکیج</th>
                      <th>حجم</th>
                      <th>مدت</th>
                      <th>قیمت واقعی (تومان)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requirements.packages.map((pkg) => (
                      <tr key={pkg.name}>
                        <td>
                          <code>{pkg.name}</code>
                        </td>
                        <td>{formatGiB(pkg.packageBytes)}</td>
                        <td>{formatInteger(pkg.durationDays)} روز</td>
                        <td>
                          <input
                            type="text"
                            inputMode="numeric"
                            dir="ltr"
                            aria-label={`قیمت ${pkg.name} به تومان`}
                            value={prices[pkg.name] ?? ''}
                            onChange={(e) =>
                              setPrices((old) => ({
                                ...old,
                                [pkg.name]: e.target.value,
                              }))
                            }
                            placeholder="تومان"
                            maxLength={19}
                            disabled={busy}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={busy}
                />{' '}
                تأیید می‌کنم هر ۲۵ قیمت را از منبع واقعی بررسی کرده‌ام و قصد ثبت
                یکجای اطلاعات در محیط آزمایشی را دارم.
              </label>
              <button
                type="button"
                disabled={!allPrices || !confirmed || busy}
                onClick={() => void submit()}
              >
                {busy
                  ? 'در حال ثبت یکپارچه…'
                  : 'تأیید و ثبت یکجای ۲۵ پکیج و ۱۵۳ مدیر'}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
