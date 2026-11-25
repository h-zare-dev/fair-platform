'use client';

import { useEffect, useState } from 'react';
import { formatGiB, formatInteger, formatUtc } from '../lib/traffic';
import {
  isAnonymizedReplayName,
  jalaliMonthLabel,
  jalaliWeekLabel,
} from '../lib/shadow-report-labels';

type Tab =
  | 'admins'
  | 'day'
  | 'week'
  | 'month'
  | 'entries'
  | 'holds'
  | 'manual'
  | 'candidates'
  | 'ignored';
type Run = {
  id: string;
  status: string;
  createdAt: string;
  sourceIdentity?: boolean;
};
type Overview = {
  mode: 'HISTORICAL_SHADOW_AUDIT';
  postingScope: 'SHADOW';
  liveBalanceMutated: false;
  weekStartDay: string;
  timeZone: string;
  runs: Run[];
  run: {
    id: string;
    source: string;
    status: string;
    catalogHash: string;
    deleteCreditEnabled: boolean;
    correlationWindowSeconds: number;
    eventCount: number;
    entryCount: number;
    heldCount: number;
    heldCandidateCount: number;
    ignoredCount: number;
    createdAt: string;
    finishedAt: string | null;
    sourceIdentity?: boolean;
  };
  coverage: {
    from: string | null;
    to: string | null;
    verifiedBoundaries: boolean;
  };
  totals: {
    observedDays: number;
    readyDays: number;
    pendingDays: number;
    chargesToman: string;
    creditsToman: string;
    netToman: string;
    heldCandidates: number;
    ignoredEvents: number;
  };
  integrity: { status: string; errors: string[]; note: string };
  historicalIdentityVerified: false;
  historicalSourceIdentity: {
    status: 'SOURCE_VERIFIED' | 'PARTIAL_SOURCE_MATCH' | 'NOT_IMPORTED';
    mappedBillingAdmins: number;
    mappedAccounts: number;
    mappedActorAdmins: number;
    unmatchedArchiveAdminPairs: number | null;
    unmatchedArchiveAccountPairs: number | null;
    unmatchedArchiveActorPairs: number | null;
    importedAt: string | null;
    currentDirectoryMatched: false;
  } | null;
};
type EventEvidence = {
  id: string;
  action: string;
  sourceTimestamp: string;
  billingAdminId: string;
  billingAdminUsername: string;
  externalUserId: string;
  accountUsername: string;
  actorAdminId: string | null;
  actorAdminUsername: string | null;
  historicalBillingAdminId?: string | null;
  historicalAccountId?: string | null;
  historicalActorId?: string | null;
  archivedBillingAdminUsername?: string;
  archivedAccountUsername?: string;
  archivedActorAdminUsername?: string | null;
  dataLimitBytes: string;
  durationSeconds: string | null;
  eventStatus: string;
  userStatus: string;
  createdAt: string | null;
  expiresAt: string | null;
};
type OperationRow = {
  operationKey: string;
  kind: string;
  code?: string;
  entryType?: string;
  billingAdminId: string;
  externalUserId: string;
  localDay: string;
  occurredAt: string;
  eventIds: string[];
  events: EventEvidence[];
  contextEvents: EventEvidence[];
  adminName: string | null;
  accountName: string | null;
  adminNameStatus: string;
  accountNameStatus: string;
  historicalAdminId?: string | null;
  eventEvidenceComplete: boolean;
  reviewKey?: string | null;
  similarRenewal?: boolean;
  amountToman?: string;
  packageId?: string;
  packageBytes?: string | null;
  durationDays?: number | null;
  referenceOperationKey?: string | null;
};
type AdminRow = {
  billingAdminId: string;
  adminName: string | null;
  nameStatus: string;
  names: string[] | null;
  historicalAdminId: string | null;
  observedDays: string;
  readyDays: string;
  pendingDays: string;
  chargeToman: string;
  creditToman: string;
  netToman: string;
  holdCount: string;
  heldCandidateCount: number;
  entryCount: string;
  status: string;
};
type PeriodRow = {
  startDate: string;
  endDate: string;
  status: string;
  observedDays: number;
  readyDays: number;
  pendingDays: number;
  entryCount: number;
  holdCount: number;
  readyChargeToman: string;
  readyCreditToman: string;
  readyNetToman: string;
  readyChargeBytes: string | null;
  chargeBytes: string | null;
  chargeToman: string | null;
  creditToman: string | null;
  netToman: string | null;
};
type IgnoredRow = { action: string; reason: string; count: number };
type PageResponse = {
  runId: string;
  rows: Array<AdminRow | PeriodRow | OperationRow | IgnoredRow>;
  nextOffset: number | null;
  bookingStatus?: string;
};

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'admins', label: 'مدیران' },
  { value: 'day', label: 'روزانه' },
  { value: 'week', label: 'هفتگی' },
  { value: 'month', label: 'ماهانه' },
  { value: 'entries', label: 'ریز تراکنش‌ها' },
  { value: 'holds', label: 'ابهامات' },
  { value: 'manual', label: 'دستیِ بدون مبلغ' },
  { value: 'candidates', label: 'عملیات متوقف‌شده' },
  { value: 'ignored', label: 'غیرمالی' },
];
const KINDS: Record<string, string> = {
  CREATE: 'ایجاد حساب',
  UPDATE_INCREASE: 'افزایش حجم',
  RENEWAL: 'تمدید (Reset + Update)',
  RESET: 'بازنشانی مستقل',
  DELETE_CREDIT: 'بستانکاری حذف',
};
const REASONS: Record<string, string> = {
  AMBIGUOUS_CORRELATION: 'ارتباط مبهم بین عملیات',
  CORRELATION_OUTSIDE_WINDOW: 'فاصلهٔ ثبت بیش از پنجرهٔ تطبیق',
  PREVIOUS_STATE_MISSING: 'وضعیت قبلی نامشخص',
  MISSING_DURATION: 'مدت پکیج نامشخص',
  DURATION_CONFLICT: 'اختلاف مدت',
  PRICING_MISSING: 'پکیج بدون قیمت مشخص',
  SOURCE_NEEDS_REVIEW: 'رویداد منبع نیازمند بررسی',
  CREDIT_SOURCE_NOT_PROVEN: 'خرید قبلی برای بستانکاری اثبات نشده',
  CREDIT_SOURCE_NOT_POSTED: 'خرید قبلی هنوز ثبت نشده',
  NEXT_PLAN_NEEDS_VERIFICATION: 'طرح بعدی تأیید نشده',
  NONBILLABLE_DECREASE: 'کاهش حجم بدون بستانکاری',
  UNCHANGED_LIMIT: 'حجم بدون تغییر',
  NONFINANCIAL_ACTION: 'رویداد غیرمالی',
  DELETE_CREDIT_DISABLED: 'بستانکاری حذف در ENV غیرفعال',
  ALREADY_CREDITED: 'خرید قبلاً بستانکار شده',
};
const ADMIN_NAME_STATUS: Record<string, string> = {
  SOURCE_WEBHOOK: 'نام ثبت‌شده در وب‌هوک پاسارگارد',
  SOURCE_VERIFIED_HISTORICAL:
    'نام تاریخی از منبع اصلی آرشیو تأیید شده؛ تطبیق با مدیر فعلی انجام نشده',
  SOURCE_VERIFIED_ID_ONLY: 'شناسهٔ تاریخی تأیید شده اما نام اصلی موجود نیست',
  PARTIAL_SOURCE_MATCH: 'تطبیق هویت برای تمام نام‌های این مدیر کامل نیست',
  HISTORICAL_NAME_CONFLICT:
    'چند نام واقعی تاریخی در منبع دیده شده؛ نام واحد حدس زده نشد',
  ARCHIVE_PSEUDONYMIZED: 'نام در خروجی قدیمی ناشناس شده است؛ تطبیق نشده',
  CONFLICT: 'چند نام متناقض در آرشیو',
  MISSING: 'نام در آرشیو موجود نیست',
};
const WEEK_NAMES: Record<string, string> = {
  SATURDAY: 'شنبه',
  SUNDAY: 'یکشنبه',
  MONDAY: 'دوشنبه',
  TUESDAY: 'سه‌شنبه',
  WEDNESDAY: 'چهارشنبه',
  THURSDAY: 'پنجشنبه',
  FRIDAY: 'جمعه',
};
const labelFor = (value: string, dictionary: Record<string, string>) =>
  dictionary[value] ?? value;
const money = (v: string | null | undefined) =>
  v === null || v === undefined
    ? 'در انتظار بررسی'
    : `${formatInteger(v)} تومان`;

async function getAudit<T>(
  view: string,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/v1/owner/operations/accounting/replay-shadow/audit/${view}?${params}`,
    {
      cache: 'no-store',
      signal,
    },
  );
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('نشست Owner منقضی شده است.');
  }
  if (response.status === 409)
    throw new Error(
      'شواهد آرشیو/کاتالوگ تغییر کرده‌اند یا این اجرا کامل نیست؛ گزارش تأیید نمی‌شود.',
    );
  if (!response.ok)
    throw new Error(`گزارش دریافت نشد (HTTP ${response.status}).`);
  return response.json() as Promise<T>;
}

function Evidence({ row }: { row: OperationRow }) {
  return (
    <details className="audit-evidence">
      <summary>شواهد رویداد ({formatInteger(row.eventIds.length)})</summary>
      {!row.eventEvidenceComplete && (
        <p className="error-banner">
          زنجیرهٔ شناسهٔ رویداد کامل یا هم‌هویت نیست؛ بدون حدس بررسی شود.
        </p>
      )}
      <p className="muted" dir="ltr">
        operation: {row.operationKey}
        {row.referenceOperationKey &&
          ` | credit-ref: ${row.referenceOperationKey}`}
      </p>
      {row.reviewKey && (
        <p className="muted" dir="ltr">
          review: {row.reviewKey}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>رویداد / نوع</th>
              <th>زمان منبع (UTC)</th>
              <th>مدیر صادرکننده</th>
              <th>وضعیت</th>
              <th>حجم دقیق</th>
              <th>مدت اثبات‌شده</th>
              <th>تاریخ ایجاد / انقضا</th>
            </tr>
          </thead>
          <tbody>
            {row.events.map((event) => (
              <tr key={event.id}>
                <td>
                  <span dir="ltr">#{event.id}</span>
                  <br />
                  {event.action}
                </td>
                <td>{formatUtc(event.sourceTimestamp)}</td>
                <td>
                  {event.actorAdminUsername ?? 'عامل نامشخص'}
                  {event.actorAdminId && (
                    <small dir="ltr"> · #{event.actorAdminId}</small>
                  )}
                  {event.historicalActorId && (
                    <small dir="ltr">
                      {' '}
                      · source #{event.historicalActorId}
                    </small>
                  )}
                </td>
                <td>
                  {event.eventStatus} / {event.userStatus}
                </td>
                <td>
                  {formatGiB(event.dataLimitBytes)}
                  <small dir="ltr"> · {event.dataLimitBytes} B</small>
                </td>
                <td>
                  {event.durationSeconds === null
                    ? 'نامشخص'
                    : `${formatInteger(event.durationSeconds)} ثانیه`}
                </td>
                <td>
                  {event.createdAt ? formatUtc(event.createdAt) : 'نامشخص'}
                  <small>
                    {event.expiresAt
                      ? formatUtc(event.expiresAt)
                      : 'انقضا نامشخص'}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {row.contextEvents?.length > 0 && (
        <>
          <p className="muted">
            حداکثر سه رویداد پیشین از <strong>همین مدیر و همین اکانت</strong>،
            صرفاً برای بررسی وضعیت قبلی:
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>رویداد قبلی</th>
                  <th>زمان منبع</th>
                  <th>حجم ثبت‌شده</th>
                  <th>مدت</th>
                  <th>انقضا</th>
                </tr>
              </thead>
              <tbody>
                {row.contextEvents.map((event) => (
                  <tr key={event.id}>
                    <td>
                      {event.action}
                      <small dir="ltr"> #{event.id}</small>
                    </td>
                    <td>{formatUtc(event.sourceTimestamp)}</td>
                    <td>{formatGiB(event.dataLimitBytes)}</td>
                    <td>
                      {event.durationSeconds
                        ? `${formatInteger(event.durationSeconds)} ثانیه`
                        : 'نامشخص'}
                    </td>
                    <td>
                      {event.expiresAt ? formatUtc(event.expiresAt) : 'نامشخص'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}

export function ShadowAuditReports({
  initialView = 'admins',
}: {
  initialView?: 'admins' | 'holds';
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [runId, setRunId] = useState('');
  const [tab, setTab] = useState<Tab>(initialView);
  const [adminId, setAdminId] = useState('');
  const [adminName, setAdminName] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    report?: PageResponse;
    error?: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    void getAudit<Overview>('overview', params, controller.signal)
      .then((data) => {
        if (
          data.mode !== 'HISTORICAL_SHADOW_AUDIT' ||
          data.postingScope !== 'SHADOW' ||
          data.liveBalanceMutated !== false
        )
          throw new Error('نوع گزارش مالی قابل تأیید نیست.');
        setOverview(data);
        setError('');
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : 'گزارش در دسترس نیست.',
          );
      });
    return () => controller.abort();
  }, [runId, refresh]);

  const periodTab = tab === 'day' || tab === 'week' || tab === 'month';
  const visibleRun =
    overview && (!runId || overview.run.id === runId) ? overview.run : null;
  const view = periodTab ? 'periods' : tab;
  let query = '';
  if (visibleRun && (!periodTab || adminId)) {
    const params = new URLSearchParams({
      runId: visibleRun.id,
      limit: '25',
      offset: String(offset),
    });
    if (periodTab) params.set('period', tab);
    if (tab === 'admins' || tab === 'ignored') {
      if (search) params.set('search', search);
    } else {
      if (adminId) params.set('billingAdminId', adminId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
    }
    if (reason && tab === 'holds') params.set('reason', reason);
    if (kind && (tab === 'entries' || tab === 'candidates'))
      params.set('kind', kind);
    query = params.toString();
  }
  // A response is renderable only for the view and filters that requested it.
  const requestKey = query ? `${refresh}:${view}?${query}` : '';
  const current = requestKey && result?.key === requestKey ? result : null;
  const report = current?.report ?? null;
  const busy = Boolean(requestKey && !current);
  const visibleError = error || current?.error;

  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    void getAudit<PageResponse>(
      view,
      new URLSearchParams(query),
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ key: requestKey, report: data });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            error: cause instanceof Error ? cause.message : 'خطای گزارش',
          });
      });
    return () => controller.abort();
  }, [requestKey, view, query]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setOffset(0);
  };
  const drillIntoPeriod = (row: PeriodRow) => {
    setFrom(row.startDate);
    setTo(row.endDate);
    setOffset(0);
    setTab(tab === 'day' ? 'entries' : 'day');
  };
  const selectedRun = overview?.run;
  return (
    <section className="audit-reports" aria-label="ممیزی کامل دفتر آزمایشی">
      <div className="catalog-source-panel audit-warning">
        <b>فقط آزمایش SHADOW — بدون تغییر موجودی واقعی</b>
        <p>
          این محاسبات بر اساس آرشیو تاریخی و فرض قیمت‌های ثابت انجام شده‌اند.
          روز مبهم بدهیِ صفر ندارد؛ مبلغش هنوز ثبت نشده است.
        </p>
        {overview?.run.sourceIdentity && (
          <p className="muted" data-testid="identity-coverage">
            نام‌ها و شناسه‌ها از وب‌هوک‌های اصلی پاسارگارد آمده‌اند.
          </p>
        )}
        {overview?.historicalSourceIdentity && (
          <p className="muted" data-testid="identity-coverage">
            وضعیت نام‌های تاریخی:{' '}
            <strong>
              {overview.historicalSourceIdentity.status === 'SOURCE_VERIFIED'
                ? 'تطبیق منبع تاریخی تکمیل شده'
                : overview.historicalSourceIdentity.status ===
                    'PARTIAL_SOURCE_MATCH'
                  ? 'تطبیق منبع تاریخی ناقص است'
                  : 'هنوز فایل خصوصی هویت وارد نشده'}
            </strong>
            {' · '}مدیران با تطبیق تاریخی:{' '}
            {formatInteger(
              overview.historicalSourceIdentity.mappedBillingAdmins,
            )}
            {' · '}اکانت‌های بازیابی‌شده:{' '}
            {formatInteger(overview.historicalSourceIdentity.mappedAccounts)}
            {' · '}عامل‌های ثبت بازیابی‌شده:{' '}
            {formatInteger(overview.historicalSourceIdentity.mappedActorAdmins)}
            {overview.historicalSourceIdentity.unmatchedArchiveAdminPairs !==
              null &&
              ` · نام‌های آرشیوی بدون تطبیق: ${formatInteger(overview.historicalSourceIdentity.unmatchedArchiveAdminPairs)}`}
            {overview.historicalSourceIdentity.unmatchedArchiveAccountPairs !==
              null &&
              ` · اکانت‌های بدون تطبیق: ${formatInteger(overview.historicalSourceIdentity.unmatchedArchiveAccountPairs)}`}
          </p>
        )}
      </div>
      <div className="audit-toolbar">
        <label>
          اجرای آزمایشی
          <select
            value={runId || selectedRun?.id || ''}
            onChange={(e) => {
              setRunId(e.target.value);
              setAdminId('');
              setAdminName('');
              setOffset(0);
            }}
          >
            {overview?.runs
              .filter((r) => r.status === 'COMPLETE')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  اجرای {r.id} — {formatUtc(r.createdAt)}
                  {r.sourceIdentity ? ' · وب‌هوک اصلی' : ' · آرشیو قدیمی'}
                </option>
              ))}
          </select>
        </label>
        <button className="secondary" onClick={() => setRefresh((v) => v + 1)}>
          تازه‌سازی و تطبیق
        </button>
      </div>
      {overview && (
        <div className="audit-overview">
          <div className="audit-kpis">
            <div>
              <small>رویدادهای خام آرشیو</small>
              <b>{formatInteger(overview.run.eventCount)}</b>
            </div>
            <div>
              <small>تراکنش‌های ثبت‌شده</small>
              <b>{formatInteger(overview.run.entryCount)}</b>
            </div>
            <div>
              <small>مبلغ بدهکار SHADOW</small>
              <b>{money(overview.totals.chargesToman)}</b>
            </div>
            <div>
              <small>بستانکاری SHADOW</small>
              <b>{money(overview.totals.creditsToman)}</b>
            </div>
            <div>
              <small>خالصِ روزهای تأییدشده</small>
              <b>{money(overview.totals.netToman)}</b>
            </div>
            <div>
              <small>عملیات قیمت‌دار اما ثبت‌نشده</small>
              <b>{formatInteger(overview.totals.heldCandidates)}</b>
            </div>
            <div>
              <small>ابهامات / روزهای معلق</small>
              <b>
                {formatInteger(overview.run.heldCount)} /{' '}
                {formatInteger(overview.totals.pendingDays)}
              </b>
            </div>
            <div>
              <small>رویدادهای بدون اثر مالی</small>
              <b>{formatInteger(overview.totals.ignoredEvents)}</b>
            </div>
          </div>
          <p className="muted">
            {overview.coverage.verifiedBoundaries
              ? 'روزهای کامل آرشیو'
              : 'روزهای مشاهده‌شده در آرشیو'}
            : {overview.coverage.from ?? 'نامشخص'} تا{' '}
            {overview.coverage.to ?? 'نامشخص'} · منطقهٔ زمانی:{' '}
            {overview.timeZone} · شروع هفته:{' '}
            {labelFor(overview.weekStartDay, WEEK_NAMES)} · بستانکاری حذف:{' '}
            {overview.run.deleteCreditEnabled ? 'فعال' : 'غیرفعال'}
          </p>
          <p className="muted">
            شمار تراکنش‌ها بر اساس عملیات مالی است. شواهد هر تراکنش، رویدادهای
            خامِ تشکیل‌دهندهٔ آن را نشان می‌دهد.
          </p>
          <p
            className={
              overview.integrity.status === 'RECONCILED'
                ? 'audit-ok'
                : 'error-banner'
            }
            role="status"
          >
            کنترل یکپارچگی دفتر:{' '}
            {overview.integrity.status === 'RECONCILED'
              ? 'جمع‌های داخلی منطبق‌اند'
              : 'اختلاف در شواهد حسابداری'}
            {overview.integrity.errors.length > 0 &&
              ` — ${overview.integrity.errors.join('، ')}`}
            <small>
              {' '}
              این بررسی به معنی تأیید هویت تاریخی یا آمادگی حسابداری واقعی نیست.
            </small>
          </p>
        </div>
      )}
      <nav className="audit-tabs" aria-label="گزارش‌های مالی">
        {TABS.map((item) => (
          <button
            type="button"
            key={item.value}
            aria-current={tab === item.value ? 'page' : undefined}
            className={tab === item.value ? 'audit-active' : 'secondary'}
            onClick={() => switchTab(item.value)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="audit-toolbar audit-filters">
        {tab !== 'admins' && tab !== 'ignored' && (from || to) && (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setFrom('');
              setTo('');
              setOffset(0);
            }}
          >
            کل بازهٔ آرشیو
          </button>
        )}
        {tab !== 'admins' && tab !== 'ignored' && (
          <label>
            {visibleRun?.sourceIdentity
              ? 'شناسهٔ مدیر در پاسارگارد'
              : 'شناسهٔ مدیر تاریخی'}
            <input
              value={adminId}
              dir="ltr"
              placeholder="انتخاب از تب مدیران یا وارد کردن ID"
              onChange={(e) => {
                setAdminId(e.target.value.replace(/[^0-9]/g, ''));
                setAdminName('');
                setOffset(0);
              }}
            />
          </label>
        )}
        {(tab === 'admins' || tab === 'ignored') && (
          <label>
            جست‌وجو
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="شناسه، نام مدیر یا نوع رویداد"
            />
          </label>
        )}
        {tab !== 'admins' && tab !== 'ignored' && (
          <>
            <label>
              از تاریخ شمسی
              <input
                value={from}
                dir="ltr"
                placeholder="1405-09-01"
                onChange={(e) => {
                  setFrom(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <label>
              تا تاریخ شمسی
              <input
                value={to}
                dir="ltr"
                placeholder="1405-09-30"
                onChange={(e) => {
                  setTo(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
          </>
        )}
        {tab === 'holds' && (
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
              {Object.entries(REASONS)
                .filter(([k]) => /^[A-Z_]+$/.test(k))
                .map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        )}
        {(tab === 'entries' || tab === 'candidates') && (
          <label>
            نوع عملیات
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">همهٔ عملیات</option>
              {Object.entries(KINDS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {adminId && (
        <p className="muted">
          گزارش مدیر تاریخی: <b>{adminName || `#${adminId}`}</b> ·{' '}
          {visibleRun?.sourceIdentity ? 'شناسهٔ پاسارگارد' : 'شناسهٔ آرشیوی'}{' '}
          <span dir="ltr">{adminId}</span>
        </p>
      )}
      {visibleError && (
        <p className="error-banner" role="alert">
          {visibleError}
        </p>
      )}
      {busy && (
        <p className="muted" role="status">
          در حال دریافت ریزگزارش…
        </p>
      )}
      {!busy &&
        !report &&
        ['day', 'week', 'month'].includes(tab) &&
        !adminId && (
          <p className="catalog-source-panel">
            ابتدا از تب «مدیران»، مدیر موردنظر را انتخاب کن تا ریزگزارش روزانه،
            هفتگی یا ماهانهٔ همان مدیر نمایش داده شود.
          </p>
        )}
      {report && (
        <>
          <div className="table-scroll audit-table">
            <table>
              {tab === 'admins' ? (
                <>
                  <thead>
                    <tr>
                      <th>مدیر تاریخی / شناسه</th>
                      <th>روزهای بررسی‌شده</th>
                      <th>آماده / مبهم</th>
                      <th>بدهکاری</th>
                      <th>بستانکاری</th>
                      <th>خالص آماده</th>
                      <th>ثبت‌شده / ابهام / متوقف‌شده</th>
                      <th>مشاهده</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.rows as AdminRow[]).map((r) => (
                      <tr key={r.billingAdminId}>
                        <td>
                          {r.adminName &&
                          (r.nameStatus === 'SOURCE_WEBHOOK' ||
                            !isAnonymizedReplayName(r.adminName))
                            ? r.adminName
                            : 'نام واقعی مدیر هنوز تطبیق نشده'}
                          <small dir="ltr"> #{r.billingAdminId}</small>
                          {r.historicalAdminId && (
                            <small dir="ltr">
                              {' '}
                              شناسهٔ اصلی تاریخی: #{r.historicalAdminId}
                            </small>
                          )}
                          {r.adminName &&
                            r.nameStatus !== 'SOURCE_WEBHOOK' &&
                            isAnonymizedReplayName(r.adminName) && (
                              <small dir="ltr">
                                شناسهٔ ناشناس آرشیو: {r.adminName}
                              </small>
                            )}
                          {r.nameStatus !== 'VERIFIED_IN_ARCHIVE' && (
                            <small>
                              {' '}
                              · {labelFor(r.nameStatus, ADMIN_NAME_STATUS)}
                            </small>
                          )}
                        </td>
                        <td>{formatInteger(r.observedDays)}</td>
                        <td>
                          {formatInteger(r.readyDays)} /{' '}
                          {formatInteger(r.pendingDays)}
                        </td>
                        <td>{money(r.chargeToman)}</td>
                        <td>{money(r.creditToman)}</td>
                        <td>
                          {money(r.netToman)}
                          {r.status === 'PENDING_REVIEW' && (
                            <small> · فقط روزهای آماده</small>
                          )}
                        </td>
                        <td>
                          {formatInteger(r.entryCount)} /{' '}
                          {formatInteger(r.holdCount)} /{' '}
                          {formatInteger(r.heldCandidateCount)}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setAdminId(r.billingAdminId);
                              setAdminName(
                                r.adminName &&
                                  (r.nameStatus === 'SOURCE_WEBHOOK' ||
                                    !isAnonymizedReplayName(r.adminName))
                                  ? r.adminName
                                  : 'مدیر تاریخی بدون تطبیق هویت',
                              );
                              setFrom('');
                              setTo('');
                              switchTab('day');
                            }}
                          >
                            گزارش این مدیر
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : ['day', 'week', 'month'].includes(tab) ? (
                <>
                  <thead>
                    <tr>
                      <th>بازهٔ شمسی</th>
                      <th>وضعیت</th>
                      <th>روزهای مشاهده‌شده / آماده / معلق</th>
                      <th>تعداد عملیات / ابهام</th>
                      <th>بدهکاری آماده</th>
                      <th>بستانکاری آماده</th>
                      <th>خالص آماده</th>
                      <th>جمع حجم ثبت‌شده</th>
                      <th>ریزگزارش</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.rows as PeriodRow[]).map((r) => (
                      <tr key={r.startDate}>
                        <td>
                          {tab === 'week' && overview && (
                            <strong>
                              {jalaliWeekLabel(
                                r.startDate,
                                r.endDate,
                                overview.weekStartDay,
                              )}
                            </strong>
                          )}
                          {tab === 'month' && (
                            <strong>{jalaliMonthLabel(r.startDate)}</strong>
                          )}
                          {tab !== 'day' && <br />}
                          <span dir="ltr">{r.startDate}</span>
                          {r.endDate !== r.startDate && (
                            <>
                              {' '}
                              تا <span dir="ltr">{r.endDate}</span>
                            </>
                          )}
                        </td>
                        <td>
                          <span
                            className={
                              r.status === 'RECONCILED'
                                ? 'audit-ok'
                                : 'audit-pending'
                            }
                          >
                            {r.status === 'RECONCILED'
                              ? 'قابل تطبیق در SHADOW'
                              : r.status === 'PENDING_REVIEW'
                                ? 'در انتظار رفع ابهام'
                                : 'پوشش آرشیو ناقص'}
                          </span>
                        </td>
                        <td>
                          {formatInteger(r.observedDays)} /{' '}
                          {formatInteger(r.readyDays)} /{' '}
                          {formatInteger(r.pendingDays)}
                        </td>
                        <td>
                          {formatInteger(r.entryCount)} /{' '}
                          {formatInteger(r.holdCount)}
                        </td>
                        <td>{r.readyDays ? money(r.readyChargeToman) : '—'}</td>
                        <td>{r.readyDays ? money(r.readyCreditToman) : '—'}</td>
                        <td>
                          {r.readyDays ? money(r.readyNetToman) : '—'}
                          {r.netToman === null && (
                            <small> · جمع نهایی ندارد</small>
                          )}
                        </td>
                        <td>
                          {r.readyDays && r.readyChargeBytes != null
                            ? formatGiB(r.readyChargeBytes)
                            : '—'}
                          {r.readyDays > 0 &&
                            r.readyChargeBytes != null &&
                            r.chargeBytes === null && (
                              <small> · جمع بخش آماده</small>
                            )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => drillIntoPeriod(r)}
                          >
                            {tab === 'day' ? 'ریزتراکنش‌ها' : 'مشاهدهٔ روزها'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : tab === 'ignored' ? (
                <>
                  <thead>
                    <tr>
                      <th>رویداد</th>
                      <th>دلیل بدون اثر مالی</th>
                      <th>تعداد رویداد</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.rows as IgnoredRow[]).map((r) => (
                      <tr key={`${r.action}:${r.reason}`}>
                        <td>{r.action}</td>
                        <td>{labelFor(r.reason, REASONS)}</td>
                        <td>{formatInteger(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr>
                      <th>مدیر تاریخی</th>
                      <th>اکانت</th>
                      <th>زمان / روز</th>
                      <th>
                        {tab === 'holds' || tab === 'manual'
                          ? 'علت بررسی'
                          : 'نوع عملیات'}
                      </th>
                      <th>پکیج / مدت</th>
                      <th>مبلغ</th>
                      <th>رویدادهای مستند</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.rows as OperationRow[]).map((r) => (
                      <tr key={r.operationKey}>
                        <td>
                          {r.adminName &&
                          (r.adminNameStatus === 'SOURCE_WEBHOOK' ||
                            !isAnonymizedReplayName(r.adminName))
                            ? r.adminName
                            : 'نام واقعی مدیر تطبیق نشده'}
                          <small dir="ltr"> #{r.billingAdminId}</small>
                          {r.events[0]?.historicalBillingAdminId && (
                            <small dir="ltr">
                              {' '}
                              شناسهٔ اصلی تاریخی: #
                              {r.events[0].historicalBillingAdminId}
                            </small>
                          )}
                          {r.adminName &&
                            r.adminNameStatus !== 'SOURCE_WEBHOOK' &&
                            isAnonymizedReplayName(r.adminName) && (
                              <small dir="ltr">{r.adminName}</small>
                            )}
                        </td>
                        <td>
                          {r.accountName &&
                          (r.accountNameStatus === 'SOURCE_WEBHOOK' ||
                            !isAnonymizedReplayName(r.accountName))
                            ? r.accountName
                            : 'نام واقعی اکانت هنوز تطبیق نشده'}
                          <small dir="ltr"> #{r.externalUserId}</small>
                          {r.events[0]?.historicalAccountId && (
                            <small dir="ltr">
                              {' '}
                              شناسهٔ اصلی تاریخی: #
                              {r.events[0].historicalAccountId}
                            </small>
                          )}
                        </td>
                        <td>
                          <span dir="ltr">{r.localDay}</span>
                          <small>{formatUtc(r.occurredAt)}</small>
                        </td>
                        <td>
                          {tab === 'holds' || tab === 'manual'
                            ? labelFor(r.code ?? '', REASONS)
                            : labelFor(r.kind, KINDS)}
                          <small dir="ltr">{r.code ?? r.entryType}</small>
                          {r.similarRenewal && (
                            <small className="audit-pending">
                              تمدید هم‌زمان مشابه · نیازمند بررسی منبع
                            </small>
                          )}
                        </td>
                        <td>
                          {r.packageBytes
                            ? formatGiB(r.packageBytes)
                            : 'بدون پکیج تأییدشده'}
                          <small>
                            {r.durationDays
                              ? `${formatInteger(r.durationDays)} روز`
                              : 'مدت نامشخص'}
                          </small>
                        </td>
                        <td>
                          {tab === 'manual'
                            ? 'بدون مبلغ تأییدشده'
                            : tab === 'holds'
                              ? 'محاسبه نشده'
                              : money(r.amountToman)}
                          {tab === 'candidates' && (
                            <small>ثبت نشده / NOT_BOOKED</small>
                          )}
                        </td>
                        <td>
                          <Evidence row={r} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
            {!report.rows.length && (
              <p className="muted">موردی در این محدوده پیدا نشد.</p>
            )}
          </div>
          <div className="audit-pagination">
            <button
              type="button"
              className="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              صفحهٔ قبل
            </button>
            <span>شروع از ردیف {formatInteger(offset + 1)}</span>
            <button
              type="button"
              className="secondary"
              disabled={report.nextOffset === null}
              onClick={() => setOffset(report.nextOffset!)}
            >
              صفحهٔ بعد
            </button>
          </div>
        </>
      )}
    </section>
  );
}
