'use client';
import { useEffect, useState } from 'react';
import { shadowReasons } from '../lib/shadow-reasons';
import { OwnerHeader } from './owner-header';
import { ReportAdminFilter } from './report-admin-filter';
import { ReportDateRangePicker } from './report-date-range-picker';
import { formatGiB, formatInteger } from '../lib/traffic';

const views = {
  admins: 'مدیران',
  day: 'روزانه',
  week: 'هفتگی',
  month: 'ماهانه',
  transactions: 'ریز تراکنش‌ها',
  ambiguities: 'ابهامات',
  manual: 'دستی بدون مبلغ',
  blocked: 'عملیات متوقف‌شده',
  nonfinancial: 'غیرمالی',
};
type View = keyof typeof views;
type Row = {
  totalBytes?: string;
  totalAmount?: string;
  admin: string | null;
  name: string | null;
  day: string;
  detail: string | null;
  account: string | null;
  bytes: string | null;
  amount: string | null;
  pending: number;
};
type Page = { rows: Row[]; nextOffset: number | null };

export function WebhookReports() {
  const [view, setView] = useState<View>('admins');
  const [admin, setAdmin] = useState('');
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('');
  const [retry, setRetry] = useState(0);
  function selectAdmin(id: string, label: string) {
    setAdmin(id);
    setName(label);
    setOffset(0);
  }
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ view, offset: String(offset) });
    if (search && (view === 'admins' || view === 'nonfinancial'))
      params.set('search', search);
    if (reason && view === 'ambiguities') params.set('reason', reason);
    if (action && (view === 'transactions' || view === 'blocked'))
      params.set('action', action);
    if (admin) params.set('admin', admin);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    setPage(null);
    setFailed(false);
    void fetch('/api/v1/owner/operations/accounting/reports?' + params, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) location.assign('/login');
        if (!response.ok) throw new Error();
        const result = (await response.json()) as Page;
        if (!controller.signal.aborted) setPage(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [view, admin, from, to, offset, retry, search, reason, action]);
  const details = [
    'transactions',
    'ambiguities',
    'manual',
    'blocked',
    'nonfinancial',
  ].includes(view);
  return (
    <>
      <OwnerHeader active="reports" />
      <main className="dashboard webhook-accounting" dir="rtl">
        <div className="stage">
          حسابداری سایه · بدون صدور صورتحساب یا ارسال گزارش
        </div>
        <div className="intro">
          <h1>گزارش‌های جامع حسابداری</h1>
        </div>
        <div className="filters">
          {(view === 'admins' || view === 'nonfinancial') && (
            <label>
              جست‌وجو
              <input
                type="search"
                maxLength={64}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
          )}
          {view === 'ambiguities' && (
            <label>
              دلیل ابهام
              <select
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">همهٔ دلایل</option>
                {Object.entries(shadowReasons).map(([code, title]) => (
                  <option key={code} value={code}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(view === 'transactions' || view === 'blocked') && (
            <label>
              نوع عملیات
              <select
                value={action}
                onChange={(e) => {
                  setAction(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">همهٔ عملیات</option>
                {Object.entries({
                  user_created: 'ایجاد',
                  user_updated: 'ویرایش',
                  data_usage_reset: 'ریست حجم',
                  user_deleted: 'حذف',
                  user_enabled: 'فعال‌سازی',
                  user_disabled: 'غیرفعال‌سازی',
                  user_expired: 'انقضا',
                  user_limited: 'اتمام حجم',
                }).map(([code, title]) => (
                  <option key={code} value={code}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ReportAdminFilter
            selectedId={admin}
            selectedName={name}
            onSelect={selectAdmin}
          />
          <ReportDateRangePicker
            calendar="jalali"
            weekStart="SATURDAY"
            timeZone="Asia/Tehran"
            from={from}
            to={to}
            onChange={(start, end) => {
              setFrom(start);
              setTo(end);
              setOffset(0);
            }}
          />
        </div>
        <nav className="webhook-copy-actions" aria-label="نوع گزارش">
          {(Object.keys(views) as View[]).map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={view === key}
              className={view === key ? '' : 'secondary'}
              onClick={() => {
                setView(key);
                setOffset(0);
              }}
            >
              {views[key]}
            </button>
          ))}
        </nav>
        <section className="table-card">
          <div className="section-heading">
            <h2>صورتحساب وبهوک</h2>
            <strong>{views[view]}</strong>
          </div>
          {failed ? (
            <p role="alert">
              دریافت گزارش ناموفق بود.{' '}
              <button onClick={() => setRetry(retry + 1)}>تلاش دوباره</button>
            </p>
          ) : !page ? (
            <p role="status">در حال دریافت گزارش…</p>
          ) : !page.rows.length ? (
            <p className="empty">برای این فیلتر رکوردی ثبت نشده است.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>مدیر</th>
                    {view !== 'admins' && <th>تاریخ</th>}
                    {details && <th>حساب</th>}
                    {details && <th>عملیات</th>}
                    <th>حجم تأییدشده</th>
                    <th>مبلغ (تومان)</th>
                    <th>ابهام باز</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, index) => (
                    <tr key={index}>
                      <td>
                        {row.admin ? (
                          <button
                            className="secondary"
                            onClick={() => {
                              selectAdmin(row.admin!, row.name || row.admin!);
                              setView('transactions');
                            }}
                          >
                            {row.name || row.admin}
                          </button>
                        ) : (
                          name || 'همهٔ مدیران'
                        )}
                      </td>
                      {view !== 'admins' && <td>{row.day || '—'}</td>}
                      {details && <td>{row.account || '—'}</td>}
                      {details && <td>{row.detail || '—'}</td>}
                      <td>{row.bytes === null ? '—' : formatGiB(row.bytes)}</td>
                      <td>
                        {row.amount === null ? '—' : formatInteger(row.amount)}
                      </td>
                      <td>{formatInteger(row.pending)}</td>
                    </tr>
                  ))}
                </tbody>
                {page.rows[0]?.totalBytes && page.rows[0]?.totalAmount && (
                  <tfoot>
                    <tr>
                      <th colSpan={view === 'admins' ? 1 : 2}>جمع بازه</th>
                      <td>{formatGiB(page.rows[0].totalBytes)}</td>
                      <td>{formatInteger(page.rows[0].totalAmount)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          <div className="section-heading">
            <button
              disabled={!page || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              قبلی
            </button>
            <button
              disabled={page?.nextOffset == null}
              onClick={() => setOffset(page!.nextOffset!)}
            >
              بعدی
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
