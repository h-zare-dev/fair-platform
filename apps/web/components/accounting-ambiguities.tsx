'use client';
import { useEffect, useState } from 'react';
import { ReportAdminFilter } from './report-admin-filter';
import { ReportDateRangePicker } from './report-date-range-picker';
import { shadowReasons as names } from '../lib/shadow-reasons';
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
  rateAssignmentId: string | null;
  rateTomanPerGib: string | null;
  accountName: string | null;
  ownerName: string | null;
  actorName: string | null;
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
export function AccountingAmbiguities({
  reports = false,
}: { reports?: boolean } = {}) {
  const [admin, setAdmin] = useState('');
  const [adminName, setAdminName] = useState('');
  const [reason, setReason] = useState('');
  const [day, setDay] = useState('');
  const [applied, setApplied] = useState({
    source: 'primary',
    admin: '',
    reason: '',
    date: '',
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
      periodSoldBytes: string;
      periodAmountToman: string;
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
      reports
        ? null
        : get<Summary>(`/api/v1/owner/operations/accounting/summary?${counts}`),
      reports
        ? { rows: [], nextOffset: null }
        : get<Page>(
            `/api/v1/owner/operations/accounting/ambiguities?${params}`,
          ),
      get<typeof days>(
        `/api/v1/owner/operations/accounting/days?${new URLSearchParams({ ...Object.fromEntries(params), period, offset: String(reportOffset) })}`,
      ),
      reports
        ? { packages: [] }
        : get<{ packages: { id: string; name: string }[] }>(
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
  }, [applied, offset, revision, period, reportOffset, reports]);
  const selection = page.rows.filter((r) => selected.includes(r.eventId));
  const first = selection[0];
  const rate =
    first?.rateAssignmentId &&
    first.rateTomanPerGib &&
    BigInt(first.dataLimitBytes) > 0n &&
    selection.every(
      (r) =>
        r.accountId === first.accountId &&
        r.billingAdminId === first.billingAdminId &&
        r.localDay === first.localDay &&
        r.sourceInstanceId === first.sourceInstanceId &&
        r.dataLimitBytes === first.dataLimitBytes &&
        r.rateAssignmentId === first.rateAssignmentId,
    )
      ? first
      : null;
  async function decide(chosen: string | null, rateAssignmentId?: string) {
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
            rateAssignmentId,
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
      <OwnerHeader active={reports ? 'reports' : 'dashboard'} />
      <main className="dashboard webhook-accounting" dir="rtl">
        <div className="stage">
          حسابداری سایه · بدون صدور صورتحساب یا ارسال گزارش
        </div>
        <div className="intro">
          <div>
            <h1>{reports ? 'گزارش‌های جامع حسابداری' : 'ابهامات ثبت شبانه'}</h1>
          </div>
        </div>
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setReportOffset(0);
            setOffset(0);
            setApplied({ source: 'primary', admin, reason, date: day });
          }}
        >
          <ReportAdminFilter
            selectedId={admin}
            selectedName={adminName}
            onSelect={(id, name) => {
              setAdmin(id);
              setAdminName(name);
            }}
          />
          {!reports && (
            <label>
              نوع ابهام
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                <option value="">همهٔ علت‌ها</option>
                {Object.entries(names).map(([key, value]) => (
                  <option value={key} key={key}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ReportDateRangePicker
            singleDay
            calendar="jalali"
            timeZone="Asia/Tehran"
            weekStart="SATURDAY"
            from={day}
            to={day}
            onChange={setDay}
          />
          <button className="secondary" type="submit" disabled={busy}>
            اعمال فیلتر
          </button>
        </form>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        {!reports && (
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
        )}
        <section className="table-card statement-card">
          <div className="section-heading">
            <h2>صورتحساب وبهوک</h2>
            <label>
              بازه{' '}
              <select
                aria-label="بازه"
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
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>روز</th>
                  <th>مدیر</th>
                  <th>حجم تأییدشده</th>
                  <th>مبلغ (تومان)</th>
                  <th>جمع مدیران انتخاب‌شده در بازه</th>
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
                      {formatGiB(d.periodSoldBytes)} ·{' '}
                      {formatInteger(d.periodAmountToman)} تومان
                    </td>
                    <td>
                      {d.pending
                        ? `جمع موقت · ${formatInteger(String(d.pending))} مورد در انتظار تصمیم`
                        : period === 'day'
                          ? 'آمادهٔ ارسال'
                          : 'بدون ابهام ثبت‌شده'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!days.length && !error && (
            <p className="empty">
              {busy
                ? 'در حال بارگیری…'
                : 'صورتحسابی برای این بازه ثبت نشده است.'}
            </p>
          )}
          <div className="statement-pagination">
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
          </div>
        </section>
        {!reports && (
          <>
            <section className="table-card">
              <div className="section-heading">
                <h2>موارد نیازمند بررسی</h2>
                {rate && (
                  <button
                    disabled={saving || busy}
                    onClick={() => void decide(null, rate.rateAssignmentId!)}
                  >
                    تأیید یک تمدید · {formatGiB(rate.dataLimitBytes)} ×{' '}
                    {formatInteger(rate.rateTomanPerGib!)} تومان ={' '}
                    {formatInteger(
                      (BigInt(rate.dataLimitBytes) *
                        BigInt(rate.rateTomanPerGib!) +
                        1073741823n) /
                        1073741824n,
                    )}{' '}
                    تومان
                  </button>
                )}
                {packages.length > 0 && (
                  <>
                    {' '}
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
                      disabled={
                        busy || saving || !selected.length || !packageId
                      }
                      onClick={() => void decide(packageId)}
                    >
                      ثبت یک بسته
                    </button>
                  </>
                )}
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
                  ابهامی با این فیلتر ثبت نشده است. وضعیت دریافت و اجرای شبانه
                  را جداگانه بررسی کنید.
                </p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>انتخاب</th>
                        <th>حساب و عملیات</th>
                        <th>نوع ابهام</th>
                        <th>مدیر مالک و روز</th>
                        <th>حجم و مدت</th>
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
                                    : selected.filter(
                                        (id) => id !== item.eventId,
                                      ),
                                )
                              }
                            />
                          </td>
                          <td>
                            <strong>
                              <bdi>
                                {item.accountName || 'نام کاربری ثبت نشده'}
                              </bdi>
                            </strong>
                            <small>
                              شناسهٔ حساب: {formatInteger(item.accountId)}
                            </small>
                            <small>
                              {item.action === 'user_updated'
                                ? 'ویرایش کاربر'
                                : item.action === 'data_usage_reset'
                                  ? 'بازنشانی مصرف'
                                  : item.action}
                            </small>
                          </td>
                          <td>
                            <strong>{names[item.code] ?? item.code}</strong>
                            <small>
                              انجام‌دهنده:{' '}
                              <bdi>{item.actorName || 'ثبت نشده'}</bdi>
                            </small>
                          </td>
                          <td>
                            <strong>
                              <bdi>{item.ownerName || 'نام مدیر ثبت نشده'}</bdi>{' '}
                              ({formatInteger(item.billingAdminId)})
                            </strong>
                            <small>{item.localDay}</small>
                          </td>
                          <td>
                            {formatGiB(item.dataLimitBytes)}
                            <small>
                              {item.durationDays === null
                                ? 'مدت روزانه در رویداد مشخص نیست'
                                : `${formatInteger(item.durationDays)} روز`}
                            </small>
                          </td>
                          <td>
                            {formatUtc(item.sourceTimestamp)}
                            <small>
                              ثبت ابهام: {formatUtc(item.detectedAt)}
                            </small>
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
                این بخش مبلغ یا پکیج را حدس نمی‌زند و گزارش‌های بسته‌شده را
                تغییر نمی‌دهد.
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
          </>
        )}
      </main>
    </>
  );
}
