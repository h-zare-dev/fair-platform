'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  asciiDigits,
  formatGiB,
  formatInteger,
  gibToBytes,
} from '../lib/traffic';

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
const numeric = (v: string) => {
  const value = asciiDigits(v.trim());
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw Error('یک عدد صحیح معتبر وارد کنید.');
  return value;
};
const money = (v: string) => {
  const value = numeric(v);
  if (value === '0') throw Error('مبلغ باید بیشتر از صفر باشد.');
  return value;
};
const editableGiB = (bytes: string): string => {
  const n = BigInt(bytes);
  return n % 1_073_741_824n === 0n ? String(n / 1_073_741_824n) : '';
};
const dateValue = (v: string): string | null =>
  v.trim() ? asciiDigits(v).replace(/\//g, '-') : null;

async function catalogApi<T>(path: string, payload?: unknown): Promise<T> {
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
  if (r.status === 409)
    throw Error('تداخل تاریخ، گروه یا پکیج قفل‌شده: تغییر ثبت نشد.');
  if (!r.ok)
    throw Error(
      `درخواست پذیرفته نشد (${r.status}). اطلاعات و تاریخ شمسی را بررسی کنید.`,
    );
  return r.json() as Promise<T>;
}

export function CatalogManagement() {
  const [source, setSource] = useState('synthetic');
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [groupName, setGroupName] = useState('');
  const [memberId, setMemberId] = useState('');
  const [memberGroup, setMemberGroup] = useState('');
  const [packageName, setPackageName] = useState('');
  const [volume, setVolume] = useState('50');
  const [duration, setDuration] = useState('30');
  const [cost, setCost] = useState('');
  const [packageToCopy, setPackageToCopy] = useState('');
  const [copyName, setCopyName] = useState('');
  const [copyCost, setCopyCost] = useState('');
  const [editPackageId, setEditPackageId] = useState('');
  const [editName, setEditName] = useState('');
  const [editVolume, setEditVolume] = useState('');
  const [editDuration, setEditDuration] = useState('');
  const [editCost, setEditCost] = useState('');
  const [targetKind, setTargetKind] = useState<'GROUP' | 'ADMIN'>('GROUP');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<'FIXED' | 'PER_GIB'>('FIXED');
  const [packageId, setPackageId] = useState('');
  const [rate, setRate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedEndAssignment, setSelectedEndAssignment] = useState('');
  const [changedEnd, setChangedEnd] = useState('');

  const refresh = useCallback(async () => {
    const value = await catalogApi<Config>(
      `config?source=${encodeURIComponent(source)}`,
    );
    setConfig(value);
  }, [source]);
  useEffect(() => {
    let current = true;
    void catalogApi<Config>(`config?source=${encodeURIComponent(source)}`)
      .then((v) => {
        if (current) {
          setConfig(v);
          setError('');
        }
      })
      .catch(() => {
        if (current) setError('تنظیمات تعرفه دریافت نشد.');
      });
    return () => {
      current = false;
    };
  }, [source]);
  function submit(
    e: FormEvent<HTMLFormElement>,
    request: () => Promise<unknown>,
    label: string,
  ) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    void request()
      .then(refresh)
      .then(() => setNotice(`${label} با موفقیت ثبت شد.`))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'درخواست ناموفق بود.'),
      )
      .finally(() => setBusy(false));
  }
  const groupNameOf = (id: string | null) =>
    config?.groups.find((g) => g.id === id)?.name ??
    (id ? `گروه ${id}` : 'بدون گروه');
  return (
    <section
      id="pricing"
      className="pricing-card catalog-card"
      aria-label="تنظیمات جدید تعرفه‌ها"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">FP-004 · فاز اول</p>
          <h2>گروه‌ها و پکیج‌های قیمت‌گذاری</h2>
        </div>
        <span className="badge">آزمایشی · بدون صدور صورتحساب</span>
      </div>
      <p className="muted">
        تعریف پکیج، عضویت مدیر و اختصاص تعرفه سه کار مستقل هستند. همهٔ حجم‌ها
        گیگابایت (GiB)، مدت‌ها تعداد روز و قیمت‌ها تومان صحیح‌اند. تاریخ‌های
        اعتبار شمسی و بر اساس{' '}
        <b dir="ltr">{config?.timeZone ?? 'Asia/Tehran'}</b> هستند؛ روز پایان
        نیز معتبر است.
      </p>
      <label className="source-field">
        شناسهٔ منبع آزمایشی{' '}
        <input
          dir="ltr"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          maxLength={100}
        />
      </label>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pricing-success">
          {notice}
        </p>
      )}
      <div className="pricing-grid">
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('groups', {
                  sourceInstanceId: source,
                  name: groupName,
                }),
              'گروه جدید',
            )
          }
        >
          <h3>۱. گروه مدیران</h3>
          <p className="muted">
            هر مدیر حداکثر عضو یک گروه است. تاریخچهٔ جابه‌جایی جدا ذخیره می‌شود.
          </p>
          <label>
            نام گروه{' '}
            <input
              required
              maxLength={100}
              placeholder="مثلاً نمایندگان ویژه"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </label>
          <button disabled={busy}>ساخت گروه</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('memberships', {
                  sourceInstanceId: source,
                  billingAdminId: numeric(memberId),
                  groupId: memberGroup || null,
                }),
              'عضویت مدیر',
            )
          }
        >
          <h3>مدیریت عضویت</h3>
          <p className="muted">
            فعلاً شناسهٔ آزمایشی را وارد کنید؛ انتخاب‌گر جست‌وجوی پاسارگاد بعد از
            مجوز اتصال افزوده می‌شود.
          </p>
          <label>
            شناسهٔ مدیر{' '}
            <input
              required
              dir="ltr"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              placeholder="9001"
            />
          </label>
          <label>
            گروه مقصد{' '}
            <select
              value={memberGroup}
              onChange={(e) => setMemberGroup(e.target.value)}
            >
              <option value="">خروج از گروه</option>
              {config?.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy}>ثبت عضویت / انتقال / خروج</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('packages', {
                  sourceInstanceId: source,
                  name: packageName,
                  packageBytes: gibToBytes(asciiDigits(volume)),
                  durationDays: Number(numeric(duration)),
                  amountToman: money(cost),
                }),
              'پکیج',
            )
          }
        >
          <h3>۲. ساخت پکیج</h3>
          <p className="muted">
            تاریخ به خود پکیج تعلق ندارد. قیمت پس از اولین اختصاص قفل می‌شود.
          </p>
          <label>
            نام پکیج{' '}
            <input
              required
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              maxLength={100}
              placeholder="۵۰ گیگابایت / ۳۰ روز"
            />
          </label>
          <label>
            حجم (گیگابایت){' '}
            <input
              required
              inputMode="decimal"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
            />
          </label>
          <label>
            مدت (روز){' '}
            <input
              required
              inputMode="numeric"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </label>
          <label>
            قیمت ثابت (تومان){' '}
            <input
              required
              inputMode="numeric"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
          <button disabled={busy}>ساخت پکیج</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('packages/copy', {
                  sourceInstanceId: source,
                  packageId: packageToCopy,
                  name: copyName,
                  amountToman: money(copyCost),
                }),
              'کپی پکیج',
            )
          }
        >
          <h3>کپی پکیج</h3>
          <p className="muted">
            برای تغییر قیمت، پکیج جدا با نام و قیمت جدید بسازید؛ پکیج‌های قبلی
            دست‌نخورده‌اند.
          </p>
          <label>
            پکیج مبنا{' '}
            <select
              required
              value={packageToCopy}
              onChange={(e) => setPackageToCopy(e.target.value)}
            >
              <option value="">انتخاب کنید</option>
              {config?.packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            نام پکیج جدید{' '}
            <input
              required
              maxLength={100}
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
            />
          </label>
          <label>
            قیمت جدید (تومان){' '}
            <input
              required
              inputMode="numeric"
              value={copyCost}
              onChange={(e) => setCopyCost(e.target.value)}
            />
          </label>
          <button disabled={busy}>کپی با نام و قیمت جدید</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('packages/edit', {
                  sourceInstanceId: source,
                  packageId: editPackageId,
                  name: editName,
                  packageBytes: gibToBytes(asciiDigits(editVolume)),
                  durationDays: Number(numeric(editDuration)),
                  amountToman: money(editCost),
                }),
              'اصلاح پکیج',
            )
          }
        >
          <h3>اصلاح قبل از اختصاص</h3>
          <p className="muted">
            فقط پکیج‌هایی که هنوز اختصاص داده نشده‌اند قابل اصلاح‌اند.
          </p>
          <label>
            انتخاب پکیج{' '}
            <select
              required
              value={editPackageId}
              onChange={(e) => {
                const p = config?.packages.find((p) => p.id === e.target.value);
                setEditPackageId(e.target.value);
                setEditName(p?.name ?? '');
                setEditVolume(p ? editableGiB(p.packageBytes) : '');
                setEditDuration(p ? String(p.durationDays) : '');
                setEditCost(p?.amountToman ?? '');
              }}
            >
              <option value="">انتخاب کنید</option>
              {config?.packages
                .filter((p) => !p.everAssigned)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            نام{' '}
            <input
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>
          <label>
            گیگابایت{' '}
            <input
              required
              value={editVolume}
              onChange={(e) => setEditVolume(e.target.value)}
              placeholder="برای حجم اعشاری مقدار دقیق را وارد کنید"
            />
          </label>
          <label>
            روز{' '}
            <input
              required
              value={editDuration}
              onChange={(e) => setEditDuration(e.target.value)}
            />
          </label>
          <label>
            تومان{' '}
            <input
              required
              value={editCost}
              onChange={(e) => setEditCost(e.target.value)}
            />
          </label>
          <button disabled={busy}>ذخیرهٔ اصلاحات</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('assignments', {
                  sourceInstanceId: source,
                  targetKind,
                  targetId: numeric(targetId),
                  ...(mode === 'FIXED'
                    ? { packageId }
                    : { rateTomanPerGiB: money(rate) }),
                  startDate: dateValue(startDate),
                  endDate: dateValue(endDate),
                }),
              'اختصاص تعرفه',
            )
          }
        >
          <h3>۳. اختصاص تعرفه</h3>
          <p className="muted">
            تعرفهٔ اختصاصی مدیر بر گروه اولویت دارد. بازه‌های متداخل برای یک حجم
            و مدت پذیرفته نمی‌شوند.
          </p>
          <label>
            مخاطب{' '}
            <select
              value={targetKind}
              onChange={(e) => {
                setTargetKind(e.target.value as 'GROUP' | 'ADMIN');
                setTargetId('');
              }}
            >
              <option value="GROUP">گروه</option>
              <option value="ADMIN">مدیر استثنایی</option>
            </select>
          </label>
          {targetKind === 'GROUP' ? (
            <label>
              انتخاب گروه{' '}
              <select
                required
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">گروه را انتخاب کنید</option>
                {config?.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              شناسهٔ مدیر استثنایی{' '}
              <input
                required
                dir="ltr"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              />
            </label>
          )}
          <label>
            نوع قیمت{' '}
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'FIXED' | 'PER_GIB')}
            >
              <option value="FIXED">پکیج ثابت</option>
              <option value="PER_GIB">نرخ هر گیگابایت</option>
            </select>
          </label>
          {mode === 'FIXED' ? (
            <label>
              پکیج{' '}
              <select
                required
                value={packageId}
                onChange={(e) => setPackageId(e.target.value)}
              >
                <option value="">انتخاب پکیج</option>
                {config?.packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.durationDays} روز ·{' '}
                    {formatGiB(p.packageBytes)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              قیمت هر گیگابایت (تومان){' '}
              <input
                required
                inputMode="numeric"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </label>
          )}
          <label>
            تاریخ شروع شمسی (خالی = امروز){' '}
            <input
              dir="ltr"
              inputMode="numeric"
              placeholder="1405-09-10"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label>
            تاریخ پایان شمسی (خالی = نامحدود){' '}
            <input
              dir="ltr"
              inputMode="numeric"
              placeholder="1405-09-30"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
          <p className="field-hint">
            شروع پس از ثبت قابل تغییر نیست. پایان روز انتخاب‌شده نیز جزو اعتبار
            است.
          </p>
          <button disabled={busy}>ثبت اختصاص با بررسی تداخل</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                catalogApi('assignments/end', {
                  sourceInstanceId: source,
                  assignmentId: selectedEndAssignment,
                  endDate: dateValue(changedEnd),
                }),
              'پایان اعتبار',
            )
          }
        >
          <h3>تغییر تاریخ پایان</h3>
          <p className="muted">
            فقط پایان آینده، بدون اثر روی روزهای بسته‌شده و بدون تداخل تغییر
            می‌کند.
          </p>
          <label>
            اختصاص{' '}
            <select
              required
              value={selectedEndAssignment}
              onChange={(e) => setSelectedEndAssignment(e.target.value)}
            >
              <option value="">انتخاب کنید</option>
              {config?.assignments.map((a) => (
                <option key={a.id} value={a.id}>
                  #{a.id} ·{' '}
                  {a.targetKind === 'GROUP'
                    ? groupNameOf(a.groupId)
                    : `مدیر ${a.billingAdminId}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            پایان جدید شمسی (خالی = نامحدود){' '}
            <input
              dir="ltr"
              placeholder="1405-09-30"
              value={changedEnd}
              onChange={(e) => setChangedEnd(e.target.value)}
            />
          </label>
          <button disabled={busy}>ثبت پایان جدید</button>
        </form>
      </div>
      <h3>پکیج‌ها</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>نام</th>
              <th>حجم (GiB)</th>
              <th>روز</th>
              <th>قیمت (تومان)</th>
              <th>وضعیت</th>
            </tr>
          </thead>
          <tbody>
            {config?.packages.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{formatGiB(p.packageBytes)}</td>
                <td>{formatInteger(p.durationDays)}</td>
                <td>{formatInteger(p.amountToman)}</td>
                <td>{p.everAssigned ? 'قفل قیمت' : 'قابل ویرایش'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>اختصاص‌های فعلی</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>مخاطب</th>
              <th>تعرفه</th>
              <th>شروع (شمسی)</th>
              <th>پایان (شمسی)</th>
            </tr>
          </thead>
          <tbody>
            {config?.assignments.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.targetKind === 'GROUP'
                    ? groupNameOf(a.groupId)
                    : `مدیر ${a.billingAdminId}`}
                </td>
                <td>
                  {a.packageId
                    ? (config.packages.find((p) => p.id === a.packageId)
                        ?.name ?? `پکیج ${a.packageId}`)
                    : `${formatInteger(a.rateTomanPerGiB ?? '0')} تومان / گیگابایت`}
                </td>
                <td dir="ltr">{a.startDate}</td>
                <td dir="ltr">{a.endDate ?? 'نامحدود'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>تاریخچهٔ تغییر گروه مدیران</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>مدیر</th>
                <th>تغییر</th>
                <th>از</th>
                <th>به</th>
                <th>زمان</th>
              </tr>
            </thead>
            <tbody>
              {config?.membershipHistory.map((h) => (
                <tr key={h.id}>
                  <td>{h.billingAdminId}</td>
                  <td>{h.action}</td>
                  <td>{groupNameOf(h.oldGroupId)}</td>
                  <td>{groupNameOf(h.newGroupId)}</td>
                  <td dir="ltr">
                    {new Intl.DateTimeFormat('fa-IR', {
                      timeZone: config.timeZone,
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(h.changedAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
