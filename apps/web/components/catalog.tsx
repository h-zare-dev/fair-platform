'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  asciiDigits,
  bytesToEditableGiB,
  formatGiB,
  formatInteger,
  gibToBytes,
} from '../lib/traffic';
import {
  assignmentExpired,
  partitionAssignments,
} from '../lib/assignment-visibility';
import { readOwnerSource, rememberOwnerSource } from '../lib/owner-source';
import {
  AdminDirectoryPicker,
  type DirectoryStatus,
} from './admin-directory-picker';

type Group = { id: string; name: string };
type Member = { billingAdminId: string; groupId: string };
type Package = {
  id: string;
  name: string;
  packageBytes: string;
  durationDays: number;
  amountToman: string;
  everAssigned: boolean;
};
type Assignment = {
  id: string;
  targetKind: 'GROUP' | 'ADMIN';
  groupId: string | null;
  billingAdminId: string | null;
  packageId: string | null;
  rateTomanPerGiB: string | null;
  startDate: string;
  endDate: string | null;
  effectiveUntil: string | null;
  timeZone: string;
};
type History = {
  id: string;
  billingAdminId: string;
  oldGroupId: string | null;
  newGroupId: string | null;
  action: string;
  changedAt: string;
};
type Config = {
  timeZone: string;
  groups: Group[];
  memberships: Member[];
  packages: Package[];
  assignments: Assignment[];
  membershipHistory: History[];
};
type Popup =
  | { kind: 'create-group' | 'create-package' | 'special' }
  | {
      kind: 'delete-group' | 'members' | 'group-packages' | 'group-history';
      groupId: string;
    }
  | { kind: 'remove-member'; groupId: string; adminId: string }
  | {
      kind: 'edit-package' | 'copy-package' | 'package-assignments';
      packageId: string;
    }
  | { kind: 'assign'; targetKind: 'GROUP' | 'ADMIN'; targetId: string }
  | { kind: 'end'; assignmentId: string };

function integer(value: string): string {
  const n = asciiDigits(value);
  if (!/^(0|[1-9]\d*)$/.test(n)) throw Error('عدد صحیح معتبر وارد کنید.');
  return n;
}
function positive(value: string): string {
  const n = integer(value);
  if (n === '0') throw Error('مقدار باید بیشتر از صفر باشد.');
  return n;
}
function localDate(value: string): string | null {
  return value.trim() ? asciiDigits(value).replace(/\//g, '-') : null;
}
async function api<T>(path: string, payload?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/owner/catalog/${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    ...(payload === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
          body: JSON.stringify(payload),
        }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 401) {
    window.location.assign('/login');
    throw Error('نشست شما منقضی شده است.');
  }
  if (r.status === 409) {
    const result: unknown = await r.json().catch(() => null);
    if (JSON.stringify(result).includes('GROUP_HAS_HISTORY'))
      throw Error(
        'گروهی که عضو، سابقهٔ جابه‌جایی یا اختصاص پکیج دارد حذف نمی‌شود.',
      );
    if (JSON.stringify(result).includes('PACKAGE_ALREADY_ASSIGNED'))
      throw Error('این پکیج قبلاً اختصاص داده شده و دیگر قابل ویرایش نیست.');
    if (JSON.stringify(result).includes('ASSIGNMENT_CLOSED_PERIOD'))
      throw Error(
        'این تاریخ به دوره‌ای تعلق دارد که بسته شده است؛ پایان این اختصاص دیگر قابل تغییر نیست.',
      );
    throw Error('با اطلاعات قبلی تداخل دارد؛ تاریخ یا پکیج دیگری انتخاب کنید.');
  }
  if (!r.ok)
    throw Error(`درخواست پذیرفته نشد (${r.status}). ورودی‌ها را بررسی کنید.`);
  return r.json() as Promise<T>;
}

const popupTitle = (popup: Popup): string => {
  switch (popup.kind) {
    case 'create-group':
      return 'ایجاد گروه';
    case 'delete-group':
      return 'حذف گروه';
    case 'members':
      return 'مدیران گروه';
    case 'remove-member':
      return 'حذف مدیر از گروه';
    case 'group-history':
      return 'تاریخچهٔ اعضای گروه';
    case 'group-packages':
      return 'پکیج‌های گروه';
    case 'create-package':
      return 'ایجاد پکیج';
    case 'edit-package':
      return 'ویرایش پکیج';
    case 'copy-package':
      return 'کپی پکیج';
    case 'package-assignments':
      return 'اختصاص‌های پکیج';
    case 'assign':
      return popup.targetKind === 'GROUP'
        ? 'اختصاص پکیج به گروه'
        : 'پکیج ویژهٔ مدیر';
    case 'special':
      return 'اختصاص ویژهٔ مدیر';
    case 'end':
      return 'تغییر تاریخ پایان اعتبار';
  }
};

export function CatalogManagement({
  section,
}: {
  section: 'packages' | 'groups';
}) {
  const [source, setSource] = useState('synthetic');
  const [sourceDraft, setSourceDraft] = useState('synthetic');
  const [sourceReady, setSourceReady] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(
    null,
  );
  const noticeCounter = useRef(0);
  const [clock, setClock] = useState(() => Date.now());
  const [popup, setPopup] = useState<Popup | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const [name, setName] = useState('');
  const [volume, setVolume] = useState('50');
  const [duration, setDuration] = useState('30');
  const [cost, setCost] = useState('');
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [adminId, setAdminId] = useState('');
  const [adminLabels, setAdminLabels] = useState<Record<string, string>>({});
  const [directoryStatus, setDirectoryStatus] =
    useState<DirectoryStatus>('loading');
  const [mode, setMode] = useState<'FIXED' | 'PER_GIB'>('FIXED');
  const [selectedPackage, setSelectedPackage] = useState('');
  const [rate, setRate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  useEffect(() => {
    const previous = readOwnerSource();
    if (previous) {
      setSource(previous);
      setSourceDraft(previous);
    }
    setSourceReady(true);
  }, []);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(async () => {
    setConfig(await api<Config>(`config?source=${encodeURIComponent(source)}`));
  }, [source]);
  useEffect(() => {
    if (!sourceReady) return;
    let current = true;
    setLoading(true);
    void api<Config>(`config?source=${encodeURIComponent(source)}`)
      .then((data) => {
        if (current) {
          setConfig(data);
          setError('');
        }
      })
      .catch(() => {
        if (current) setError('دریافت تنظیمات پکیج‌ها ناموفق بود.');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [source, sourceReady]);
  useEffect(() => {
    if (!popup) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (
      dialog.current?.querySelector('[autofocus]') as HTMLElement | null
    )?.focus();
    if (!dialog.current?.contains(document.activeElement))
      dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKeys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) setPopup(null);
      if (e.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeys);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', handleKeys);
      opener.current?.focus();
    };
  }, [popup]);

  const groupName = (id: string | null) =>
    config?.groups.find((g) => g.id === id)?.name ??
    (id ? `گروه ${id}` : 'بدون گروه');
  const pkgName = (id: string | null) =>
    config?.packages.find((p) => p.id === id)?.name ?? `پکیج ${id ?? 'نامشخص'}`;
  const groupMembers = (id: string) =>
    config?.memberships.filter((m) => m.groupId === id) ?? [];
  const groupAssignments = (id: string) =>
    config?.assignments.filter(
      (a) => a.targetKind === 'GROUP' && a.groupId === id,
    ) ?? [];
  const packageAssignments = (id: string) =>
    config?.assignments.filter((a) => a.packageId === id) ?? [];
  const currentAssignments = (assignments: Assignment[]) =>
    partitionAssignments(assignments, clock).visible;
  const groupUsed = (id: string) =>
    groupMembers(id).length > 0 ||
    groupAssignments(id).length > 0 ||
    Boolean(
      config?.membershipHistory.some(
        (h) => h.oldGroupId === id || h.newGroupId === id,
      ),
    );

  function open(next: Popup) {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setError('');
    setName('');
    setVolume('50');
    setDuration('30');
    setCost('');
    setAdminId('');
    setBulkIds([]);
    setDirectoryStatus('loading');
    setMode('FIXED');
    setSelectedPackage('');
    setRate('');
    setStartDate('');
    setEndDate('');
    if (next.kind === 'edit-package' || next.kind === 'copy-package') {
      const p = config?.packages.find((item) => item.id === next.packageId);
      if (p) {
        setName(next.kind === 'copy-package' ? `${p.name} - کپی` : p.name);
        setVolume(bytesToEditableGiB(p.packageBytes));
        setDuration(String(p.durationDays));
        setCost(p.amountToman);
      }
    }
    if (next.kind === 'end') {
      setEndDate(
        config?.assignments.find((a) => a.id === next.assignmentId)?.endDate ??
          '',
      );
    }
    if (next.kind === 'assign' && next.targetKind === 'ADMIN')
      setAdminId(next.targetId);
    setPopup(next);
  }
  async function write(
    e: FormEvent<HTMLFormElement>,
    path: string,
    payload: () => unknown,
    label: string,
    keepOpen = false,
  ) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(path, payload());
      await refresh();
      setNotice({
        id: ++noticeCounter.current,
        text: `${label} با موفقیت انجام شد.`,
      });
      if (!keepOpen) setPopup(null);
      else {
        setAdminId('');
        setBulkIds([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'درخواست انجام نشد.');
    } finally {
      setBusy(false);
    }
  }
  function renderAssignment(a: Assignment) {
    const expired = assignmentExpired(a.effectiveUntil, clock);
    return (
      <article className="catalog-mini-card" key={a.id}>
        <div className="catalog-mini-heading">
          <strong>
            {a.packageId
              ? pkgName(a.packageId)
              : `هر گیگابایت ${formatInteger(a.rateTomanPerGiB ?? '0')} تومان`}
          </strong>
          <span className={expired ? 'catalog-tag locked' : 'catalog-tag'}>
            {expired
              ? 'پایان‌یافته'
              : a.targetKind === 'GROUP'
                ? groupName(a.groupId)
                : `مدیر ${formatInteger(a.billingAdminId ?? '0')}`}
          </span>
        </div>
        <p className="catalog-dates">
          <span>
            از <b dir="ltr">{a.startDate}</b>
          </span>
          <span>
            تا <b dir="ltr">{a.endDate ?? 'نامحدود'}</b>
          </span>
        </p>
        {!expired && (
          <button
            className="secondary catalog-small-button"
            type="button"
            onClick={() => open({ kind: 'end', assignmentId: a.id })}
          >
            تغییر تاریخ پایان
          </button>
        )}
      </article>
    );
  }
  function renderAssignmentList(
    assignments: Assignment[],
    emptyMessage: string,
  ) {
    const { visible, expired } = partitionAssignments(assignments, clock);
    return (
      <>
        <div className="catalog-mini-grid">
          {visible.length ? (
            visible.map(renderAssignment)
          ) : (
            <p className="catalog-empty">{emptyMessage}</p>
          )}
        </div>
        {expired.length > 0 && (
          <details className="catalog-history catalog-expired-history">
            <summary>
              سوابق پایان‌یافته ({formatInteger(expired.length)})
            </summary>
            <p className="field-hint">
              این اختصاص‌ها از فهرست جاری کنار رفته‌اند، اما برای حفظ سابقه حذف
              نشده‌اند.
            </p>
            <div className="catalog-mini-grid">
              {expired.map(renderAssignment)}
            </div>
          </details>
        )}
      </>
    );
  }
  const selectedGroup =
    popup && 'groupId' in popup
      ? config?.groups.find((g) => g.id === popup.groupId)
      : undefined;
  return (
    <section
      className="settings-catalog"
      aria-label="تنظیمات پکیج‌ها و گروه‌ها"
    >
      <div className="stage" data-staging-billing-mode="no-live-billing">
        محیط آزمایشی · بدون صدور صورت‌حساب یا دریافت وجه
      </div>
      {sourceReady && (
        <p className="field-hint" data-testid="active-catalog-dataset">
          مجموعهٔ فعال:{' '}
          <strong>
            {source === 'replay-30d'
              ? 'آرشیو تاریخی ۳۰روزه (آزمایشی)'
              : source === 'synthetic'
                ? 'دادهٔ ساختگی (آزمایشی)'
                : `شناسهٔ ${source}`}
          </strong>
        </p>
      )}
      <div className="settings-heading">
        <div>
          <p className="eyebrow">پنل مدیریت / تنظیمات</p>
          <h1>تنظیمات</h1>
          <p className="muted">
            پکیج‌ها و گروه‌های مدیران را جداگانه مدیریت کنید.
          </p>
        </div>
        <span className="settings-zone">
          تقویم شمسی · {config?.timeZone ?? 'Asia/Tehran'}
        </span>
      </div>
      <nav className="settings-nav" aria-label="بخش‌های تنظیمات">
        <a
          aria-current={section === 'packages' ? 'page' : undefined}
          href="/settings/packages"
        >
          <span aria-hidden="true">◈</span>
          <b>پکیج‌ها</b>
          <small>قیمت و مدت پکیج</small>
        </a>
        <a
          aria-current={section === 'groups' ? 'page' : undefined}
          href="/settings/groups"
        >
          <span aria-hidden="true">♧</span>
          <b>گروه‌ها</b>
          <small>اعضا و اختصاص پکیج</small>
        </a>
        <a href="/settings/initialization">
          <span aria-hidden="true">↻</span>
          <b>راه‌اندازی اولیه</b>
          <small>دریافت وضعیت اکانت‌ها</small>
        </a>
        <a href="/settings/security">
          <span aria-hidden="true">♙</span>
          <b>امنیت حساب</b>
          <small>تغییر رمز عبور</small>
        </a>
      </nav>
      {notice && (
        <div
          key={notice.id}
          className="catalog-toast"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="catalog-toast-body">
            <span className="catalog-toast-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <strong>عملیات موفق</strong>
              <p>{notice.text}</p>
            </div>
            <button
              type="button"
              className="catalog-toast-close"
              aria-label="بستن اعلان موفقیت"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
          <div className="catalog-toast-progress" aria-hidden="true" />
        </div>
      )}
      {error && !popup && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="catalog-section-heading">
        <div>
          <p className="eyebrow">
            {section === 'packages' ? 'مدیریت پکیج' : 'مدیریت گروه'}
          </p>
          <h2>
            {section === 'packages' ? 'پکیج‌های قیمت‌گذاری' : 'گروه‌های مدیران'}
          </h2>
          <p className="muted">
            {section === 'packages'
              ? 'قیمت و مشخصات پکیج پس از اولین اختصاص ثابت می‌ماند؛ برای قیمت جدید، کپی بگیرید.'
              : 'برای هر گروه مدیر اضافه کنید و پکیج‌های آن را با تاریخ اعتبار مشخص کنید.'}
          </p>
        </div>
        <button
          onClick={() =>
            open({
              kind: section === 'packages' ? 'create-package' : 'create-group',
            })
          }
        >
          + {section === 'packages' ? 'پکیج جدید' : 'گروه جدید'}
        </button>
      </div>
      {loading ? (
        <p role="status" className="catalog-empty">
          در حال دریافت اطلاعات…
        </p>
      ) : !config ? (
        <div className="catalog-empty">
          <p>اطلاعات دریافت نشد.</p>
          <button
            className="secondary"
            onClick={() =>
              void refresh().catch(() => setError('دریافت اطلاعات ناموفق بود.'))
            }
          >
            تلاش دوباره
          </button>
        </div>
      ) : section === 'packages' ? (
        config.packages.length ? (
          <div className="catalog-cards" data-testid="package-cards">
            {config.packages.map((p) => (
              <article className="catalog-tile" key={p.id}>
                <div className="catalog-tile-top">
                  <span className="catalog-tile-icon" aria-hidden="true">
                    ◈
                  </span>
                  <span
                    className={
                      p.everAssigned ? 'catalog-tag locked' : 'catalog-tag'
                    }
                  >
                    {p.everAssigned ? 'قیمت ثابت شده' : 'قابل ویرایش'}
                  </span>
                </div>
                <h3>{p.name}</h3>
                <div className="catalog-tile-meta">
                  <span>{formatGiB(p.packageBytes)}</span>
                  <span>{formatInteger(p.durationDays)} روز</span>
                </div>
                <p className="catalog-price">
                  {formatInteger(p.amountToman)} <small>تومان</small>
                </p>
                <div className="catalog-tile-actions">
                  <button
                    onClick={() =>
                      open({ kind: 'copy-package', packageId: p.id })
                    }
                  >
                    کپی پکیج
                  </button>
                  {!p.everAssigned && (
                    <button
                      className="secondary"
                      onClick={() =>
                        open({ kind: 'edit-package', packageId: p.id })
                      }
                    >
                      ویرایش
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() =>
                      open({ kind: 'package-assignments', packageId: p.id })
                    }
                  >
                    اختصاص‌ها و انقضا
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="catalog-empty">
            هنوز پکیجی ندارید. با «پکیج جدید» شروع کنید.
          </div>
        )
      ) : (
        <>
          {config.groups.length ? (
            <div className="catalog-cards" data-testid="group-cards">
              {config.groups.map((g) => (
                <article className="catalog-tile" key={g.id}>
                  <div className="catalog-tile-top">
                    <span
                      className="catalog-tile-icon group-icon"
                      aria-hidden="true"
                    >
                      ♧
                    </span>
                    <span className="catalog-tag">
                      {formatInteger(groupMembers(g.id).length)} مدیر
                    </span>
                  </div>
                  <h3>{g.name}</h3>
                  <div className="catalog-tile-meta">
                    <span>
                      {formatInteger(
                        currentAssignments(groupAssignments(g.id)).length,
                      )}{' '}
                      اختصاص پکیج / قیمت
                    </span>
                  </div>
                  <div className="catalog-tile-actions">
                    <button
                      onClick={() => open({ kind: 'members', groupId: g.id })}
                    >
                      مدیران گروه
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        open({ kind: 'group-packages', groupId: g.id })
                      }
                    >
                      پکیج‌های گروه
                    </button>
                    <button
                      className="secondary"
                      onClick={() =>
                        open({ kind: 'group-history', groupId: g.id })
                      }
                    >
                      تاریخچه
                    </button>
                    <button
                      className="catalog-danger"
                      disabled={groupUsed(g.id)}
                      title={
                        groupUsed(g.id)
                          ? 'گروه دارای عضو یا سابقه حذف نمی‌شود.'
                          : 'حذف گروه بدون سابقه'
                      }
                      onClick={() =>
                        open({ kind: 'delete-group', groupId: g.id })
                      }
                    >
                      حذف گروه
                    </button>
                  </div>
                  {groupUsed(g.id) && (
                    <small className="catalog-footnote">
                      گروه دارای سابقه برای حفظ گزارش‌ها قابل حذف نیست.
                    </small>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="catalog-empty">
              هنوز گروهی ایجاد نشده است. با «گروه جدید» شروع کنید.
            </div>
          )}
          <section className="catalog-special">
            <div>
              <h3>قیمت ویژه برای یک مدیر</h3>
              <p className="muted">
                اگر مدیری قیمت متفاوتی نیاز دارد، پکیج اختصاصی او بر قیمت گروه
                اولویت دارد.
              </p>
            </div>
            <button
              className="secondary"
              onClick={() => open({ kind: 'special' })}
            >
              + اختصاص ویژه
            </button>
          </section>
          {config.assignments.some((a) => a.targetKind === 'ADMIN') && (
            <details className="catalog-history">
              <summary>اختصاص‌های ویژهٔ مدیران</summary>
              {renderAssignmentList(
                config.assignments.filter((a) => a.targetKind === 'ADMIN'),
                'اختصاص ویژهٔ فعال یا آینده‌ای وجود ندارد.',
              )}
            </details>
          )}
        </>
      )}
      <details className="catalog-source-panel catalog-source-advanced">
        <summary>دربارهٔ محیط آزمایشی و تنظیمات پیشرفته</summary>
        <p className="field-hint">
          <b>منبع داده</b> یعنی فضای جداگانهٔ اطلاعات هر سامانه. شناسهٔ{' '}
          <b dir="ltr">synthetic</b> فقط اطلاعات آزمایشی فِیر پلتفرم است؛ اطلاعات
          واقعی مدیران پاسارگاد از آن خوانده نمی‌شود. تغییر شناسه، مجموعهٔ دیگری
          را نمایش می‌دهد و اطلاعات قبلی را پاک نمی‌کند.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const nextSource = sourceDraft.trim();
            rememberOwnerSource(nextSource);
            if (nextSource === source) void refresh();
            else {
              setConfig(null);
              setSource(nextSource);
            }
          }}
        >
          <label>
            شناسهٔ منبع (پیشرفته)
            <input
              dir="ltr"
              required
              maxLength={100}
              pattern="[A-Za-z0-9][A-Za-z0-9_.:-]*"
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
            />
          </label>
          <button className="secondary">نمایش این منبع</button>
        </form>
        <p className="field-hint">
          منبع فعلی: <b dir="ltr">{source}</b> · منطقهٔ زمانی از تنظیم سرور{' '}
          <b dir="ltr">FAIR_TIME_ZONE</b> دریافت می‌شود؛ بعد از تغییر ENV و
          راه‌اندازی دوبارهٔ سرویس، این برچسب هم به‌روز می‌شود. تاریخ اختصاص‌های
          قبلی با منطقهٔ زمانی ذخیره‌شدهٔ همان اختصاص باقی می‌ماند.
        </p>
      </details>
      {popup && (
        <div
          className="catalog-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setPopup(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="catalog-dialog-title"
            className="catalog-dialog"
            ref={dialog}
          >
            <header className="catalog-dialog-head">
              <div>
                <p className="eyebrow">تنظیمات</p>
                <h2 id="catalog-dialog-title">{popupTitle(popup)}</h2>
              </div>
              <button
                type="button"
                className="secondary catalog-close"
                onClick={() => setPopup(null)}
                aria-label="بستن پنجره"
              >
                ×
              </button>
            </header>
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            {popup.kind === 'create-group' && (
              <form
                className="catalog-form"
                onSubmit={(e) =>
                  void write(
                    e,
                    'groups',
                    () => ({ sourceInstanceId: source, name }),
                    'گروه جدید',
                  )
                }
              >
                <label>
                  نام گروه
                  <input
                    autoFocus
                    required
                    maxLength={100}
                    placeholder="مثلاً نمایندگان ویژه"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <button disabled={busy}>ایجاد گروه</button>
              </form>
            )}
            {popup.kind === 'delete-group' && (
              <form
                className="catalog-form"
                onSubmit={(e) =>
                  void write(
                    e,
                    'groups/delete',
                    () => ({
                      sourceInstanceId: source,
                      groupId: popup.groupId,
                    }),
                    'حذف گروه',
                  )
                }
              >
                <p>
                  گروه «{selectedGroup?.name}» را حذف می‌کنید. این کار فقط برای
                  گروهی مجاز است که هیچ عضو، سابقه یا اختصاص پکیجی نداشته باشد.
                </p>
                <button className="catalog-danger" disabled={busy}>
                  تأیید حذف گروه
                </button>
              </form>
            )}
            {(popup.kind === 'create-package' ||
              popup.kind === 'edit-package' ||
              popup.kind === 'copy-package') && (
              <form
                className="catalog-form"
                onSubmit={(e) =>
                  void write(
                    e,
                    popup.kind === 'copy-package'
                      ? 'packages/copy'
                      : popup.kind === 'edit-package'
                        ? 'packages/edit'
                        : 'packages',
                    () =>
                      popup.kind === 'copy-package'
                        ? {
                            sourceInstanceId: source,
                            packageId: popup.packageId,
                            name,
                            amountToman: positive(cost),
                          }
                        : {
                            sourceInstanceId: source,
                            ...(popup.kind === 'edit-package'
                              ? { packageId: popup.packageId }
                              : {}),
                            name,
                            packageBytes: gibToBytes(volume),
                            durationDays: Number(positive(duration)),
                            amountToman: positive(cost),
                          },
                    popup.kind === 'copy-package' ? 'کپی پکیج' : 'پکیج',
                  )
                }
              >
                {popup.kind === 'copy-package' && (
                  <p className="catalog-note">
                    حجم و مدت دقیقاً از پکیج اصلی کپی می‌شود؛ نام و قیمت جدید را
                    تعیین کنید.
                  </p>
                )}
                <label>
                  نام پکیج
                  <input
                    autoFocus
                    required
                    maxLength={100}
                    placeholder="مثلاً ۵۰ گیگابایت، ۳۰ روز"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                {popup.kind !== 'copy-package' && (
                  <div className="catalog-form-pair">
                    <label>
                      حجم (گیگابایت)
                      <input
                        required
                        inputMode="decimal"
                        dir="ltr"
                        value={volume}
                        onChange={(e) => setVolume(e.target.value)}
                        placeholder="0.5"
                      />
                    </label>
                    <label>
                      مدت (روز)
                      <input
                        required
                        inputMode="numeric"
                        dir="ltr"
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                      />
                    </label>
                  </div>
                )}
                <label>
                  قیمت پکیج (تومان)
                  <input
                    required
                    inputMode="numeric"
                    dir="ltr"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                  />
                </label>
                {popup.kind === 'edit-package' && (
                  <p className="field-hint">
                    ویرایش فقط تا پیش از اولین اختصاص پکیج مجاز است.
                  </p>
                )}
                <button disabled={busy}>
                  {popup.kind === 'copy-package'
                    ? 'ساخت کپی پکیج'
                    : 'ذخیرهٔ پکیج'}
                </button>
              </form>
            )}
            {popup.kind === 'members' && (
              <div className="catalog-dialog-content">
                <p className="muted">
                  اعضای «{selectedGroup?.name}» · هر مدیر فقط عضو یک گروه است.
                  افزودن مدیرِ عضو گروه دیگر، او را به این گروه منتقل می‌کند.
                </p>
                <div className="catalog-member-list">
                  {groupMembers(popup.groupId).length ? (
                    groupMembers(popup.groupId).map((m) => (
                      <div className="catalog-member" key={m.billingAdminId}>
                        <span>
                          {adminLabels[m.billingAdminId] ?? 'مدیر'}{' '}
                          <b dir="ltr">({m.billingAdminId})</b>
                        </span>
                        <button
                          className="secondary"
                          onClick={() =>
                            open({
                              kind: 'remove-member',
                              groupId: popup.groupId,
                              adminId: m.billingAdminId,
                            })
                          }
                        >
                          حذف از گروه
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="catalog-empty">
                      هنوز مدیری در این گروه نیست.
                    </p>
                  )}
                </div>
                <form
                  className="catalog-form"
                  onSubmit={(e) =>
                    void write(
                      e,
                      bulkIds.length ? 'memberships/bulk' : 'memberships',
                      () => ({
                        sourceInstanceId: source,
                        ...(bulkIds.length
                          ? { billingAdminIds: bulkIds }
                          : { billingAdminId: integer(adminId) }),
                        groupId: popup.groupId,
                      }),
                      'اختصاص مدیر به گروه',
                      true,
                    )
                  }
                >
                  <AdminDirectoryPicker
                    bulk={{ ids: bulkIds, set: setBulkIds, disabled: busy }}
                    value={adminId}
                    onChange={setAdminId}
                    setLabels={setAdminLabels}
                    labels={adminLabels}
                    onStatusChange={setDirectoryStatus}
                  />
                  <button
                    disabled={
                      busy ||
                      directoryStatus !== 'ready' ||
                      (!adminId && !bulkIds.length)
                    }
                  >
                    {bulkIds.length
                      ? `افزودن ${bulkIds.length} مدیر به گروه`
                      : '+ افزودن مدیر به گروه'}
                  </button>
                </form>
              </div>
            )}
            {popup.kind === 'remove-member' && (
              <form
                className="catalog-form"
                onSubmit={(e) =>
                  void write(
                    e,
                    'memberships',
                    () => ({
                      sourceInstanceId: source,
                      billingAdminId: popup.adminId,
                      groupId: null,
                    }),
                    'حذف مدیر از گروه',
                  )
                }
              >
                <p>
                  مدیر <b dir="ltr">{popup.adminId}</b> از «
                  {groupName(popup.groupId)}» خارج شود؟ سابقهٔ این تغییر ذخیره
                  می‌شود.
                </p>
                <button className="catalog-danger" disabled={busy}>
                  تأیید حذف از گروه
                </button>
              </form>
            )}
            {popup.kind === 'group-history' && (
              <div className="catalog-dialog-content">
                <p className="muted">
                  تاریخچهٔ جابه‌جایی اعضای گروه «{selectedGroup?.name}» حذف یا
                  ویرایش نمی‌شود.
                </p>
                <div className="catalog-member-list">
                  {config?.membershipHistory
                    .filter(
                      (h) =>
                        h.oldGroupId === popup.groupId ||
                        h.newGroupId === popup.groupId,
                    )
                    .map((h) => (
                      <div className="catalog-history-item" key={h.id}>
                        <strong>مدیر {formatInteger(h.billingAdminId)}</strong>
                        <span>
                          {groupName(h.oldGroupId)} ← {groupName(h.newGroupId)}
                        </span>
                        <small>
                          {new Intl.DateTimeFormat('fa-IR', {
                            timeZone: config.timeZone,
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(new Date(h.changedAt))}
                        </small>
                      </div>
                    ))}
                </div>
              </div>
            )}
            {popup.kind === 'group-packages' && (
              <div className="catalog-dialog-content">
                <p className="muted">
                  پکیج‌ها و قیمت‌های اختصاص‌یافته به «{selectedGroup?.name}».
                  تاریخ پایان روی هر اختصاص قابل تنظیم است، نه روی خود پکیج.
                  اختصاص منقضی از فهرست جاری کنار می‌رود و در سوابق می‌ماند.
                </p>
                {renderAssignmentList(
                  groupAssignments(popup.groupId),
                  'پکیج فعال یا آینده‌ای به این گروه اختصاص داده نشده است.',
                )}
                <button
                  onClick={() =>
                    open({
                      kind: 'assign',
                      targetKind: 'GROUP',
                      targetId: popup.groupId,
                    })
                  }
                >
                  + اختصاص پکیج به گروه
                </button>
              </div>
            )}
            {popup.kind === 'package-assignments' && (
              <div className="catalog-dialog-content">
                <p className="muted">
                  تاریخ پایان مربوط به هر اختصاص پکیج «
                  {pkgName(popup.packageId)}» است؛ قیمت خود پکیج تغییر نمی‌کند.
                </p>
                {renderAssignmentList(
                  packageAssignments(popup.packageId),
                  'این پکیج اختصاص فعال یا آینده‌ای ندارد.',
                )}
              </div>
            )}
            {popup.kind === 'special' && (
              <div className="catalog-dialog-content">
                <p className="muted">
                  مدیر موردنظر را از فهرست پاسارگاد انتخاب کنید تا پکیج یا قیمت
                  اختصاصی برای او ثبت شود.
                </p>
                <form
                  className="catalog-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    try {
                      open({
                        kind: 'assign',
                        targetKind: 'ADMIN',
                        targetId: integer(adminId),
                      });
                    } catch (reason) {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : 'شناسه نامعتبر است.',
                      );
                    }
                  }}
                >
                  <AdminDirectoryPicker
                    value={adminId}
                    onChange={setAdminId}
                    setLabels={setAdminLabels}
                    labels={adminLabels}
                    onStatusChange={setDirectoryStatus}
                  />
                  <button disabled={directoryStatus !== 'ready' || !adminId}>
                    ادامه
                  </button>
                </form>
              </div>
            )}
            {popup.kind === 'assign' && (
              <form
                className="catalog-form"
                onSubmit={(e) =>
                  void write(
                    e,
                    'assignments',
                    () => ({
                      sourceInstanceId: source,
                      targetKind: popup.targetKind,
                      targetId: popup.targetId,
                      ...(mode === 'FIXED'
                        ? { packageId: selectedPackage }
                        : { rateTomanPerGiB: positive(rate) }),
                      startDate: localDate(startDate),
                      endDate: localDate(endDate),
                    }),
                    'اختصاص پکیج',
                  )
                }
              >
                <p className="catalog-note">
                  {popup.targetKind === 'GROUP'
                    ? `گروه: ${groupName(popup.targetId)}`
                    : `مدیر: ${formatInteger(popup.targetId)}`}
                </p>
                <label>
                  نوع قیمت
                  <select
                    value={mode}
                    onChange={(e) =>
                      setMode(e.target.value as 'FIXED' | 'PER_GIB')
                    }
                  >
                    <option value="FIXED">پکیج با قیمت ثابت</option>
                    <option value="PER_GIB">قیمت هر گیگابایت</option>
                  </select>
                </label>
                {mode === 'FIXED' ? (
                  <label>
                    انتخاب پکیج
                    <select
                      autoFocus
                      required
                      value={selectedPackage}
                      onChange={(e) => setSelectedPackage(e.target.value)}
                    >
                      <option value="">انتخاب کنید</option>
                      {config?.packages.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {formatGiB(p.packageBytes)} ·{' '}
                          {p.durationDays} روز
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    قیمت هر گیگابایت (تومان)
                    <input
                      autoFocus
                      required
                      dir="ltr"
                      inputMode="numeric"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                    />
                  </label>
                )}
                <div className="catalog-form-pair">
                  <label>
                    شروع شمسی (خالی = امروز)
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      placeholder="1405-09-10"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </label>
                  <label>
                    پایان شمسی (خالی = نامحدود)
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      placeholder="1405-09-30"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </label>
                </div>
                <p className="field-hint">
                  روز پایان هم معتبر است. شروع پس از ثبت تغییر نمی‌کند. تداخل
                  زمانی خودکار بررسی می‌شود.
                </p>
                <button disabled={busy}>ثبت اختصاص پکیج</button>
              </form>
            )}
            {popup.kind === 'end' && (
              <form
                className="catalog-form"
                onSubmit={(e) =>
                  void write(
                    e,
                    'assignments/end',
                    () => ({
                      sourceInstanceId: source,
                      assignmentId: popup.assignmentId,
                      endDate: localDate(endDate),
                    }),
                    'تاریخ پایان',
                  )
                }
              >
                <p className="catalog-note">
                  تاریخ شروع این اختصاص ثابت است. تغییر پایان فقط تا زمانی مجاز
                  است که بازهٔ قبلی و جدید وارد روزهای بسته‌شده نشده باشند و با
                  اختصاص دیگری تداخل نکنند. به‌جای حذف، پایان دسترسی را ثبت کنید
                  تا تاریخچه حفظ شود.
                </p>
                <label>
                  تاریخ پایان شمسی (خالی = نامحدود)
                  <input
                    autoFocus
                    dir="ltr"
                    inputMode="numeric"
                    placeholder="1405-09-30"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </label>
                <button disabled={busy}>ذخیرهٔ تاریخ پایان</button>
              </form>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
