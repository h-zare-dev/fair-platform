'use client';
import { useEffect, useState } from 'react';
import { OwnerHeader } from './owner-header';
import { formatGiB, formatInteger, formatUtc } from '../lib/traffic';

interface Summary {
  closedDays: string;
  pendingDays: string;
  ambiguityCount: string;
  chargeCount: string;
  lateCount: string;
}
interface Case {
  eventId: string;
  accountId: string;
  action: string;
  code: string;
  sourceInstanceId: string;
  billingAdminId: string;
  localDay: string;
  dataLimitBytes: string;
  durationDays: number | null;
  sourceTimestamp: string;
  detectedAt: string;
}
interface Page {
  rows: Case[];
  nextOffset: number | null;
}
const names: Record<string, string> = {
  MISSING_DURATION: 'مدت پکیج قابل اثبات نیست',
  PRICING_MISSING: 'پکیج یا قیمت متناظر تعریف نشده',
  UNEXPECTED_UNLIMITED: 'حجم نامحدود نیازمند بررسی است',
  AMBIGUOUS_CORRELATION: 'ارتباط رویدادها نامشخص است',
  AMBIGUOUS_CORRECTION: 'حذف یا ایجاد مجدد در همان روز',
  PRICING_CONFIG_CONFLICT: 'تداخل یا خطای تنظیمات پکیج',
  LATE_EVENT_AFTER_CLOSE: 'رویداد پس از بستن روز دریافت شده',
};
async function get<T>(url: string): Promise<T> {
  const result = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (result.status === 401) {
    window.location.assign('/login');
    throw new Error('نشست منقضی شده است.');
  }
  if (!result.ok) throw new Error('دریافت داده‌ها ناموفق بود.');
  return result.json() as Promise<T>;
}
export function AccountingAmbiguities() {
  const [source, setSource] = useState('');
  const [admin, setAdmin] = useState('');
  const [reason, setReason] = useState('');
  const [day, setDay] = useState('');
  const [applied, setApplied] = useState({
    source: '',
    admin: '',
    reason: '',
    day: '',
  });
  const [period, setPeriod] = useState('day');
  const [reportOffset, setReportOffset] = useState(0);
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [page, setPage] = useState<Page>({ rows: [], nextOffset: null });
  const [selected, setSelected] = useState<string[]>([]);
  const [packageId, setPackageId] = useState('');
  const [packages, setPackages] = useState<{ id: string; name: string }[]>([]);
  const [days, setDays] = useState<
    {
      source: string;
      admin: string;
      day: string;
      amountToman: string;
      soldBytes: string;
      pending: number;
    }[]
  >([]);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setBusy(true);
    setSelected([]);
    setError('');
    const params = new URLSearchParams({
      ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v)),
      offset: String(offset),
      limit: '25',
    });
    const counts = new URLSearchParams(
      applied.source ? { source: applied.source } : {},
    );
    void Promise.all([
      get<Summary>(`/api/v1/owner/operations/accounting/summary?${counts}`),
      get<Page>(`/api/v1/owner/operations/accounting/ambiguities?${params}`),
      get<typeof days>(
        `/api/v1/owner/operations/accounting/days?${new URLSearchParams({ ...Object.fromEntries(params), period, offset: String(reportOffset) })}`,
      ),
      get<{ packages: { id: string; name: string }[] }>(
        `/api/v1/owner/catalog/config?source=${encodeURIComponent(applied.source || 'primary')}`,
      ),
    ])
      .then(([s, p, daily, catalog]) => {
        if (active) {
          setDays(daily);
          setPackages(catalog.packages);
          setSummary(s);
          setPage(p);
        }
      })
      .catch(() => {
        if (active)
          setError(
            'فهرست ابهامات در دسترس نیست؛ اتصال و اجرای شبانه را بررسی کنید.',
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [applied, offset, revision, period, reportOffset]);
  async function decide(chosen: string | null) {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(
        '/api/v1/owner/operations/accounting/review',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-fair-csrf': '1' },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            eventIds: selected,
            packageId: chosen,
          }),
        },
      );
      if (!response.ok) throw new Error();
      setRevision((v) => v + 1);
    } catch {
      setError(
        'تصمیم ثبت نشد. رویدادهای یک حساب، یک مدیر و یک روز را انتخاب کنید.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <OwnerHeader active="dashboard" />
      <main className="dashboard" dir="rtl">
        <div className="stage">
          حسابداری سایه · بدون صدور صورتحساب یا ارسال گزارش
        </div>
        <div className="intro">
          <div>
            <p className="eyebrow">FP-005 / ثبت شبانه</p>
            <h1>ابهامات ثبت شبانه</h1>
            <p className="muted">
              این صفحه موارد ثبت شبانه را نشان می‌دهد. برای بررسی آرشیو تاریخی،
              تب ابهامات را در گزارش‌های حسابداری باز کنید.
            </p>
          </div>
          <a className="secondary" href="/reports?view=holds">
            ابهامات آرشیو تاریخی
          </a>
        </div>
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setReportOffset(0);
            setOffset(0);
            setApplied({ source, admin, reason, day });
          }}
        >
          <label>
            منبع
            <input
              dir="ltr"
              maxLength={100}
              placeholder="همه"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <label>
            شناسهٔ مدیر
            <input
              dir="ltr"
              inputMode="numeric"
              placeholder="همه"
              value={admin}
              onChange={(e) => setAdmin(e.target.value)}
            />
          </label>
          <label>
            نوع ابهام
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">همهٔ علت‌ها</option>
              {Object.entries(names).map(([key, value]) => (
                <option value={key} key={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            روز شمسی
            <input
              dir="ltr"
              placeholder="1405-08-29"
              pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
          <button className="secondary" type="submit" disabled={busy}>
            اعمال فیلتر
          </button>
        </form>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <div className="kpis">
          {(
            [
              ['روزهای پردازش‌شده', summary?.closedDays],
              ['روزهای متوقف‌شده', summary?.pendingDays],
              ['ابهامات شبانه', summary?.ambiguityCount],
              ['رویدادهای دیرهنگام', summary?.lateCount],
            ] as [string, string | undefined][]
          ).map(([title, value]) => (
            <section className="kpi" key={title}>
              <h2>{title}</h2>
              <p className="number">
                {busy ? '…' : value ? formatInteger(value) : '—'}
              </p>
            </section>
          ))}
        </div>
        <section className="table-card">
          <h2>صورتحساب وبهوک</h2>
          <label>
            بازه{' '}
            <select
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value);
                setReportOffset(0);
              }}
            >
              <option value="day">روزانه</option>
              <option value="week">هفتگی</option>
              <option value="month">ماهانه</option>
            </select>
          </label>
          <table>
            <thead>
              <tr>
                <th>روز</th>
                <th>مدیر</th>
                <th>حجم تأییدشده</th>
                <th>مبلغ (تومان)</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={JSON.stringify([d.source, d.admin, d.day])}>
                  <td>{d.day}</td>
                  <td>{formatInteger(d.admin)}</td>
                  <td>{formatGiB(d.soldBytes)}</td>
                  <td>{formatInteger(d.amountToman)}</td>
                  <td>
                    {d.pending
                      ? `جمع موقت · ${formatInteger(String(d.pending))} مورد در انتظار تصمیم`
                      : 'آمادهٔ ارسال'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            disabled={busy || reportOffset === 0}
            onClick={() => setReportOffset(reportOffset - 25)}
          >
            قبلی
          </button>
          <button
            disabled={busy || days.length < 25}
            onClick={() => setReportOffset(reportOffset + 25)}
          >
            بعدی
          </button>
        </section>
        <section className="table-card">
          <div className="section-heading">
            <h2>موارد نیازمند بررسی</h2>
            <label>
              بسته{' '}
              <select
                value={packageId}
                onChange={(e) => setPackageId(e.target.value)}
              >
                <option value="">انتخاب بسته</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || saving || !selected.length || !packageId}
              onClick={() => void decide(packageId)}
            >
              ثبت یک بسته
            </button>
            <button
              disabled={busy || saving || !selected.length}
              onClick={() => void decide(null)}
            >
              بدون اثر مالی
            </button>
          </div>
          {busy ? (
            <p className="empty">در حال بارگیری…</p>
          ) : page.rows.length === 0 ? (
            <p className="empty">
              ابهامی با این فیلتر ثبت نشده است. وضعیت دریافت و اجرای شبانه را
              جداگانه بررسی کنید.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>انتخاب</th>
                    <th>نوع ابهام</th>
                    <th>روز و مدیر</th>
                    <th>پکیج</th>
                    <th>زمان رویداد</th>
                    <th>شناسهٔ رویداد</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((item) => (
                    <tr key={item.eventId}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`انتخاب رویداد ${item.eventId}`}
                          checked={selected.includes(item.eventId)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, item.eventId]
                                : selected.filter((id) => id !== item.eventId),
                            )
                          }
                        />
                      </td>
                      <td>
                        <strong>{names[item.code] ?? item.code}</strong>
                        <small dir="ltr">
                          {item.action} · {item.accountId}
                        </small>
                      </td>
                      <td>
                        {item.localDay}
                        <small>
                          مدیر: {formatInteger(item.billingAdminId)} ·{' '}
                          {item.sourceInstanceId}
                        </small>
                      </td>
                      <td>
                        {formatGiB(item.dataLimitBytes)}
                        <small>
                          {item.durationDays === null
                            ? 'مدت نامشخص'
                            : `${formatInteger(item.durationDays)} روز`}
                        </small>
                      </td>
                      <td>
                        {formatUtc(item.sourceTimestamp)}
                        <small>ثبت ابهام: {formatUtc(item.detectedAt)}</small>
                      </td>
                      <td>{formatInteger(item.eventId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="pagination">
          <span>
            این بخش مبلغ یا پکیج را حدس نمی‌زند و گزارش‌های بسته‌شده را تغییر
            نمی‌دهد.
          </span>
          {offset > 0 && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              صفحهٔ قبل
            </button>
          )}
          {page.nextOffset !== null && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setOffset(page.nextOffset!)}
            >
              صفحهٔ بعد
            </button>
          )}
        </div>
      </main>
    </>
  );
}
