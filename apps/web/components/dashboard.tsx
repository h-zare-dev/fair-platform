'use client';
import { useEffect, useState } from 'react';
import { OwnerHeader } from './owner-header';
import { ReplayImport } from './replay-import';
import { ReplayAccountingPreview } from './replay-accounting-preview';
import { formatGiB, formatInteger, formatUtc } from '../lib/traffic';
import { readOwnerSource, rememberOwnerSource } from '../lib/owner-source';
interface Summary {
  pendingBatches: string;
  processedBatches: string;
  processedLast24h: string;
  start: string;
  end: string;
  receivedBatches: string;
  normalizedEvents: string;
  openIngestionIssues: string;
  failedBatches: string;
}
interface EventRow {
  id: string;
  action: string;
  externalUserId: string;
  userStatus: string;
  dataLimitBytes: string;
  sourceTimestamp: string;
  receivedAt: string;
  firstSeenAt: string;
  eventStatus: string;
  billingAdminId: string;
  actorStatus: string;
  occurrenceCount: number;
}
interface IssueRow {
  id: string;
  code: string;
  message: string;
  batchIndex: number | null;
  createdAt: string;
  receivedAt: string;
  resolved: boolean;
}
interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}
const eventNames: Record<string, string> = {
  user_created: 'ایجاد کاربر',
  user_updated: 'ویرایش کاربر',
  user_deleted: 'حذف کاربر',
  user_limited: 'اتمام حجم کاربر',
  user_expired: 'انقضای کاربر',
  user_enabled: 'فعال‌سازی کاربر',
  user_disabled: 'غیرفعال‌سازی کاربر',
  data_usage_reset: 'بازنشانی مصرف',
  subscription_revoked: 'لغو اشتراک',
  data_reset_by_next: 'بازنشانی با طرح بعدی',
};
const statusNames: Record<string, string> = {
  active: 'فعال',
  on_hold: 'معلق',
  disabled: 'غیرفعال',
  expired: 'منقضی‌شده',
  limited: 'اتمام حجم',
  READY_FOR_ACCOUNTING: 'آمادهٔ بررسی حسابداری',
  NEEDS_REVIEW: 'نیازمند بررسی',
  IGNORED_NON_FINANCIAL: 'غیرمالی',
  KNOWN: 'شناخته‌شده',
  UNIDENTIFIED: 'شناسایی‌نشده',
  ABSENT: 'بدون عامل ثبت‌شده',
};
const issueNames: Record<string, string> = {
  INVALID_EVENT: 'ساختار رویداد نامعتبر',
  INVALID_SOURCE_TIMESTAMP: 'زمان ثبت‌شده در منبع نامعتبر',
  UNKNOWN_ACTION: 'عملیات پشتیبانی‌نشده',
  MISSING_REQUIRED_FIELD: 'اطلاعات الزامی ناقص',
  DUPLICATE_EVENT: 'رویداد تکراری',
  NORMALIZATION_FAILED: 'خطا در پردازش رویداد',
  INGESTION_ISSUE: 'رویداد نیازمند بررسی',
};
const translation = (value: string, names: Record<string, string>) =>
  names[value] ?? `کد ${value}`;
const progressPercent = (processed: string, received: string) =>
  BigInt(received) === 0n
    ? 0
    : Number((BigInt(processed) * 100n) / BigInt(received));
async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`/api/v1/owner/${path}`, {
    cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(10000),
  });
  if (r.status === 401) {
    window.location.assign('/login');
    throw new Error('نشست شما منقضی شده است.');
  }
  if (!r.ok)
    throw new Error('اطلاعات عملیاتی در دسترس نیست؛ دوباره تلاش کنید.');
  return (await r.json()) as T;
}
function DataTable({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty: boolean;
}) {
  return (
    <section className="table-card">
      <div className="section-heading">
        <h2>{title}</h2>
        <span className="badge">آزمایشی</span>
      </div>
      {empty ? (
        <p className="empty">در این بازه زمانی داده‌ای ثبت نشده است.</p>
      ) : (
        <div className="table-scroll">{children}</div>
      )}
    </section>
  );
}
export function Dashboard() {
  const [windowRange, setWindowRange] = useState('24h');
  const [source, setSource] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceReady, setSourceReady] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<Page<EventRow>>({
    rows: [],
    nextCursor: null,
  });
  const [issues, setIssues] = useState<Page<IssueRow>>({
    rows: [],
    nextCursor: null,
  });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [pageBusy, setPageBusy] = useState(false);
  useEffect(() => {
    const previous = readOwnerSource();
    if (previous) {
      setSource(previous);
      setSourceDraft(previous);
      if (previous === 'replay-30d') setWindowRange('replay-fixed');
    }
    setSourceReady(true);
  }, []);
  useEffect(() => {
    if (!sourceReady) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10000);
    setBusy(true);
    setError('');
    setSummary(null);
    setEvents({ rows: [], nextCursor: null });
    setIssues({ rows: [], nextCursor: null });
    const params = new URLSearchParams({
      window: windowRange === 'replay-fixed' ? '30d' : windowRange,
      ...(source ? { source } : {}),
      ...(windowRange === 'replay-fixed'
        ? {
            start: '2026-10-21T20:21:41.000Z',
            end: '2026-11-20T20:21:41.000Z',
          }
        : {}),
    });
    void (async () => {
      try {
        const result = await request<Summary>(
          `operations/summary?${params}`,
          abort.signal,
        );
        params.set('start', result.start);
        params.set('end', result.end);
        const [e, i] = await Promise.all([
          request<Page<EventRow>>(`operations/events?${params}`, abort.signal),
          request<Page<IssueRow>>(`operations/issues?${params}`, abort.signal),
        ]);
        if (!abort.signal.aborted) {
          setSummary(result);
          setEvents(e);
          setIssues(i);
        }
      } catch {
        if (!abort.signal.aborted)
          setError('اطلاعات عملیاتی دریافت نشد. تعدادها قابل نمایش نیستند.');
      } finally {
        clearTimeout(timeout);
        if (!abort.signal.aborted) setBusy(false);
      }
    })();
    // Report a bounded timeout rather than leaving loading active indefinitely.
    const onAbort = () => {
      setBusy(false);
      setError('زمان پاسخ‌گویی تمام شد. لطفاً دوباره تلاش کنید.');
    };
    abort.signal.addEventListener('abort', onAbort);
    return () => {
      abort.signal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      abort.abort();
    };
  }, [windowRange, source, refresh, sourceReady]);
  async function next(kind: 'events' | 'issues') {
    const cursor = kind === 'events' ? events.nextCursor : issues.nextCursor;
    if (!cursor || !summary) return;
    setPageBusy(true);
    setError('');
    const params = new URLSearchParams({
      start: summary.start,
      end: summary.end,
      cursor,
      ...(source ? { source } : {}),
    });
    try {
      if (kind === 'events')
        setEvents(await request<Page<EventRow>>(`operations/events?${params}`));
      else
        setIssues(await request<Page<IssueRow>>(`operations/issues?${params}`));
    } catch {
      setError('صفحهٔ بعد بارگیری نشد؛ دوباره تلاش کنید.');
    } finally {
      setPageBusy(false);
    }
  }
  const cards = [
    [
      'دسته‌های دریافتی',
      summary?.receivedBatches,
      'دسته‌های یکتای ثبت‌شده',
      '↙',
    ],
    [
      'رویدادهای پردازش‌شده',
      summary?.normalizedEvents,
      'رویدادهای یکتای دسته‌های دریافتی در این بازه',
      '◈',
    ],
    ['خطاهای باز', summary?.openIngestionIssues, 'خطاهای منتظر بررسی', '!'],
    ['دسته‌های ناموفق', summary?.failedBatches, 'خطاهای موقت و دائمی', '×'],
  ];
  return (
    <>
      <OwnerHeader active="dashboard" />
      <main className="dashboard">
        <div className="stage" data-staging-billing-mode="no-live-billing">
          <span className="stage-dot" aria-hidden="true" /> محیط آزمایشی · دادهٔ
          تست دریافت داده · حسابداری سایه · بدون دریافت وجه واقعی
        </div>
        <div className="intro">
          <div>
            <p className="eyebrow">داشبورد مدیریت / نمای کلی</p>
            <h1>
              سلام، خوش آمدید <span aria-hidden="true">✦</span>
            </h1>
            <p className="muted">
              رویدادها و خطاها را اینجا ببینید؛ مدیریت پکیج‌ها و گروه‌ها در بخش
              تنظیمات انجام می‌شود. زمان رویدادهای فنی بر اساس UTC نمایش داده
              می‌شود.
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy || pageBusy}
            onClick={() => setRefresh((v) => v + 1)}
          >
            <span aria-hidden="true">↻</span> به‌روزرسانی
          </button>
        </div>
        <nav className="quick-nav" aria-label="بخش‌های پنل">
          <a href="#overview">نمای کلی</a>
          <a href="#events">تاریخچهٔ رویدادها</a>
          <a href="#issues">خطاهای پردازش</a>
          <a href="/accounting/ambiguities">ابهامات حسابداری</a>
        </nav>
        <form
          className="filters"
          id="overview"
          onSubmit={(e) => {
            e.preventDefault();
            rememberOwnerSource(sourceDraft);
            setSource(sourceDraft);
          }}
        >
          <label>
            بازهٔ زمانی
            <select
              value={windowRange}
              disabled={pageBusy}
              onChange={(e) => {
                setWindowRange(e.target.value);
                if (e.target.value === 'replay-fixed') {
                  setSourceDraft('replay-30d');
                  setSource('replay-30d');
                  rememberOwnerSource('replay-30d');
                }
              }}
            >
              <option value="1h">یک ساعت گذشته</option>
              <option value="24h">۲۴ ساعت گذشته</option>
              <option value="7d">۷ روز گذشته</option>
              <option value="30d">۳۰ روز گذشته</option>
              <option value="replay-fixed">آرشیو واقعی ۳۰روزه</option>
            </select>
          </label>
          <label>
            شناسهٔ منبع
            <input
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
              placeholder="همهٔ منابع"
              dir="ltr"
              maxLength={100}
              pattern="[A-Za-z0-9_.\-]+"
            />
          </label>
          <button className="secondary" disabled={busy || pageBusy}>
            اعمال فیلتر
          </button>
        </form>
        <ReplayImport />
        <ReplayAccountingPreview />
        {error && (
          <div className="error-banner" role="alert">
            {error}{' '}
            <button
              className="secondary"
              onClick={() => setRefresh((v) => v + 1)}
            >
              تلاش دوباره
            </button>
          </div>
        )}
        <div className="kpis" aria-busy={busy}>
          {cards.map(([name, count, description, symbol]) => (
            <section className="kpi" key={name}>
              <span className="kpi-symbol" aria-hidden="true">
                {symbol}
              </span>
              <h2>{name}</h2>
              <p className="number">
                {busy ? '…' : count ? formatInteger(count) : '—'}
              </p>
              <p className="muted">{description}</p>
            </section>
          ))}
        </div>
        {busy ? (
          <p role="status" className="empty">
            در حال دریافت اطلاعات…
          </p>
        ) : (
          summary && (
            <>
              <section
                className="inbox-progress"
                aria-label="پیشرفت پردازش رویدادها"
              >
                <span>
                  دسته‌های پردازش‌شده:{' '}
                  <strong>{formatInteger(summary.processedBatches)}</strong> از{' '}
                  <strong>{formatInteger(summary.receivedBatches)}</strong>
                </span>
                <progress
                  value={progressPercent(
                    summary.processedBatches,
                    summary.receivedBatches,
                  )}
                  max={100}
                  aria-label="درصد تکمیل پردازش دسته‌های انتخاب‌شده"
                />
              </section>
              <p className="range">
                <span>
                  دسته‌های در انتظار:{' '}
                  <strong>{formatInteger(summary.pendingBatches)}</strong>
                </span>
                <span>
                  دسته‌های ناموفق:{' '}
                  <strong>{formatInteger(summary.failedBatches)}</strong>
                </span>
                <span>
                  رویدادهای تازه پردازش‌شده در ۲۴ ساعت اخیر (زمان سرور):{' '}
                  <strong>{formatInteger(summary.processedLast24h)}</strong>
                </span>
                <span>
                  از {formatUtc(summary.start)} تا {formatUtc(summary.end)}{' '}
                  (زمان دریافت دسته‌ها؛ بدون احتساب زمان پایان)
                </span>
              </p>
              <div id="events" className="anchor-section">
                <DataTable
                  title="تاریخچهٔ رویدادهای اخیر"
                  empty={!events.rows.length}
                >
                  <table>
                    <thead>
                      <tr>
                        {[
                          'عملیات و کاربر',
                          'زمان رویداد و دریافت',
                          'حجم بسته و مالک',
                          'وضعیت و انجام‌دهنده',
                          'تعداد تکرار',
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {events.rows.map((e) => (
                        <tr key={e.id}>
                          <td>
                            <strong>{translation(e.action, eventNames)}</strong>
                            <small>
                              کاربر {formatInteger(e.externalUserId)} ·{' '}
                              {translation(e.userStatus, statusNames)}
                            </small>
                          </td>
                          <td>
                            {formatUtc(e.sourceTimestamp)}
                            <small>
                              اولین دریافت: {formatUtc(e.firstSeenAt)}
                            </small>
                          </td>
                          <td>
                            {formatGiB(e.dataLimitBytes)}
                            <small>
                              مدیر حساب: {formatInteger(e.billingAdminId)}
                            </small>
                          </td>
                          <td>
                            {translation(e.eventStatus, statusNames)}
                            <small>
                              انجام‌دهنده:{' '}
                              {translation(e.actorStatus, statusNames)}
                            </small>
                          </td>
                          <td>{formatInteger(e.occurrenceCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </div>
              <div className="pagination">
                <span>
                  مرتب‌سازی بر اساس دریافت تاریخی دسته‌ها؛ زمان رویداد در منبع
                  جداگانه نمایش داده می‌شود. «آمادهٔ حسابداری» به معنی ثبت هزینه
                  نیست.
                </span>
                {events.nextCursor && (
                  <button
                    className="secondary"
                    disabled={pageBusy}
                    onClick={() => {
                      void next('events');
                    }}
                  >
                    رویدادهای بعدی ←
                  </button>
                )}
              </div>
              <div id="issues" className="anchor-section">
                <DataTable
                  title="خطاهای اخیر دریافت داده"
                  empty={!issues.rows.length}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>نوع خطا</th>
                        <th>زمان دریافت / ثبت خطا (UTC)</th>
                        <th>شمارهٔ دسته</th>
                        <th>وضعیت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.rows.map((i) => (
                        <tr key={i.id}>
                          <td>
                            <strong>{translation(i.code, issueNames)}</strong>
                            <small>
                              کد فنی: <span dir="ltr">{i.code}</span>
                            </small>
                          </td>
                          <td>
                            {formatUtc(i.receivedAt)}
                            <small>ثبت خطا: {formatUtc(i.createdAt)}</small>
                          </td>
                          <td>
                            {i.batchIndex === null
                              ? '—'
                              : formatInteger(i.batchIndex)}
                          </td>
                          <td>{i.resolved ? 'برطرف‌شده' : 'باز'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              </div>
              <div className="pagination">
                <span>
                  فقط پیام‌های امن نمایش داده می‌شوند؛ محتوای خام داده‌ها قابل
                  مشاهده نیست.
                </span>
                {issues.nextCursor && (
                  <button
                    className="secondary"
                    disabled={pageBusy}
                    onClick={() => {
                      void next('issues');
                    }}
                  >
                    خطاهای بعدی ←
                  </button>
                )}
              </div>
            </>
          )
        )}
        <footer>
          فِیر پلتفرم · محیط آزمایشی · بدون دریافت وجه یا صدور صورتحساب
        </footer>
      </main>
    </>
  );
}
