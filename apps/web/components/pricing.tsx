'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  asciiDigits,
  fixedRowsToCatalog,
  formatGiB,
  formatInteger,
  formatUtc,
  gibToBytes,
} from '../lib/traffic';

interface Plan {
  id: string;
  name: string;
}
interface Version {
  id: string;
  planId: string | null;
  billingAdminId: string | null;
  mode: string;
  rateTomanPerGiB: string | null;
  fixedPackages: Record<string, string>;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
interface Assignment {
  id: string;
  planId: string;
  billingAdminId: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
interface Config {
  plans: Plan[];
  versions: Version[];
  assignments: Assignment[];
}
interface Quote {
  amountToman: string;
  source: string;
  ruleVersionId: string;
  billableBytes: string;
  mode: string;
}
const numeric = /^(0|[1-9]\d*)$/;
const iso = (v: string) => {
  if (!v.trim()) throw Error('تاریخ و ساعت به وقت UTC الزامی است.');
  const d = new Date(v);
  if (!Number.isFinite(d.getTime()))
    throw Error('تاریخ یا ساعت UTC معتبر نیست.');
  return d.toISOString();
};
const modeLabel: Record<string, string> = {
  PER_GIB: 'قیمت به‌ازای گیگابایت',
  FIXED: 'بسته با قیمت ثابت',
  MIXED: 'ترکیبی',
};
const quoteSource: Record<string, string> = {
  DEFAULT_PLAN: 'طرح پیش‌فرض',
  ASSIGNED_PLAN: 'طرح اختصاص‌یافته',
  ADMIN_OVERRIDE: 'قیمت اختصاصی مدیر',
};
async function endpoint<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/owner/pricing/${path}`, {
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
  if (response.status === 401) {
    window.location.assign('/login');
    throw Error('نشست شما منقضی شده است؛ دوباره وارد شوید.');
  }
  if (!response.ok)
    throw Error(
      `درخواست قیمت‌گذاری پذیرفته نشد (کد ${response.status}). تاریخ‌ها، دسترسی و تداخل بازه‌ها را بررسی کنید.`,
    );
  return response.json() as Promise<T>;
}
export function PricingManagement() {
  const [source, setSource] = useState('synthetic');
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [planName, setPlanName] = useState('');
  const [target, setTarget] = useState('plan');
  const [planId, setPlanId] = useState('');
  const [adminId, setAdminId] = useState('');
  const [mode, setMode] = useState<'PER_GIB' | 'FIXED' | 'MIXED'>('PER_GIB');
  const [rate, setRate] = useState('');
  const [packageRows, setPackageRows] = useState([{ gib: '', toman: '' }]);
  const [from, setFrom] = useState('2026-12-01T00:00:00Z');
  const [until, setUntil] = useState('2027-01-01T00:00:00Z');
  const [assignAdmin, setAssignAdmin] = useState('');
  const [assignPlan, setAssignPlan] = useState('');
  const [gib, setGib] = useState('1');
  const [quoteAdmin, setQuoteAdmin] = useState('9001');
  const [quoteAt, setQuoteAt] = useState('2026-12-15T00:00:00Z');
  const [quote, setQuote] = useState<Quote | null>(null);

  const refresh = useCallback(async () => {
    const next = await endpoint<Config>(
      `config?source=${encodeURIComponent(source)}`,
    );
    setConfig(next);
  }, [source]);
  useEffect(() => {
    let mounted = true;
    void endpoint<Config>(`config?source=${encodeURIComponent(source)}`)
      .then((v) => {
        if (mounted) {
          setConfig(v);
          setError('');
        }
      })
      .catch((e) => {
        if (mounted) setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      mounted = false;
    };
  }, [source]);
  async function action(fn: () => Promise<unknown>, label: string) {
    setLoading(true);
    setError('');
    setNotice('');
    setQuote(null);
    try {
      await fn();
      await refresh();
      setNotice(
        `${label} با موفقیت ثبت شد. سوابق قبلی بدون تغییر باقی می‌مانند.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'عملیات انجام نشد.');
    } finally {
      setLoading(false);
    }
  }
  function submit(
    e: FormEvent<HTMLFormElement>,
    fn: () => Promise<unknown>,
    label: string,
  ) {
    e.preventDefault();
    void action(fn, label);
  }
  const validAdmin = (v: string) => {
    const normalized = asciiDigits(v);
    if (!numeric.test(normalized))
      throw Error('شناسهٔ مدیر باید عدد صحیح غیرمنفی باشد.');
    return normalized;
  };
  const validRate = (v: string) => {
    const normalized = asciiDigits(v);
    if (!/^[1-9]\d*$/.test(normalized))
      throw Error('نرخ هر گیگابایت باید عدد صحیح مثبت به تومان باشد.');
    return normalized;
  };
  async function preview() {
    setLoading(true);
    setError('');
    setQuote(null);
    try {
      const result = await endpoint<Quote>('quote', {
        sourceInstanceId: source,
        billingAdminId: validAdmin(quoteAdmin),
        occurredAt: iso(quoteAt),
        billableBytes: gibToBytes(gib),
        purpose: 'FULL_PACKAGE',
      });
      setQuote(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'پیش‌نمایش قیمت در دسترس نیست.',
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <section
      className="pricing-card"
      id="pricing"
      aria-label="تنظیمات قیمت‌گذاری"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">مدیریت تعرفه‌ها · فاز چهارم</p>
          <h2>ساخت و مدیریت بسته‌های اینترنت</h2>
        </div>
        <span className="badge">فقط مدیر اصلی</span>
      </div>
      <p className="muted pricing-description">
        این بخش مخصوص تنظیم تعرفه و محاسبهٔ آزمایشی است؛ هیچ مبلغی از حساب کسی
        کسر یا ثبت مالی زنده نمی‌شود. هر گیگابایت در این سامانه برابر با
        ۱٬۰۷۳٬۷۴۱٬۸۲۴ بایت (GiB) است. بازه‌های زمانی به وقت UTC و بدون احتساب
        لحظهٔ پایان‌اند.
      </p>
      <label className="source-field">
        شناسهٔ منبع قیمت‌گذاری
        <input
          value={source}
          maxLength={100}
          dir="ltr"
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      {error && (
        <p className="error-banner" role="alert">
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
                endpoint('plans', { sourceInstanceId: source, name: planName }),
              'طرح جدید',
            )
          }
        >
          <span className="step-number">۰۱</span>
          <h3>ایجاد طرح</h3>
          <p className="muted">
            ابتدا برای بسته یا تعرفهٔ خود یک نام انتخاب کنید.
          </p>
          <label>
            نام طرح
            <input
              required
              maxLength={100}
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              placeholder="مثلاً بستهٔ یک‌ماههٔ ۵۰ گیگابایت"
            />
          </label>
          <button disabled={loading}>ثبت طرح جدید</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                endpoint('versions', {
                  sourceInstanceId: source,
                  ...(target === 'plan'
                    ? { planId }
                    : { billingAdminId: validAdmin(adminId) }),
                  mode,
                  rateTomanPerGiB:
                    mode === 'FIXED'
                      ? null
                      : rate.trim()
                        ? validRate(rate)
                        : null,
                  fixedPackages:
                    mode === 'PER_GIB'
                      ? {}
                      : fixedRowsToCatalog(packageRows, mode === 'MIXED'),
                  effectiveFrom: iso(from),
                  effectiveUntil: until.trim() ? iso(until) : null,
                }),
              'نسخهٔ جدید تعرفه',
            )
          }
        >
          <span className="step-number">۰۲</span>
          <h3>تعریف تعرفه و حجم</h3>
          <p className="muted">
            تعرفه‌های ثبت‌شده قابل ویرایش نیستند؛ نسخهٔ جدید بسازید.
          </p>
          <label>
            تعرفه برای
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="plan">یک طرح</option>
              <option value="override">قیمت اختصاصی مدیر حساب</option>
            </select>
          </label>
          {target === 'plan' ? (
            <label>
              انتخاب طرح
              <select
                required
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">یک طرح انتخاب کنید</option>
                {config?.plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (شناسهٔ {p.id})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              شناسهٔ مدیر حساب
              <input
                required
                value={adminId}
                onChange={(e) => setAdminId(e.target.value)}
                placeholder="9001"
              />
            </label>
          )}
          <label>
            مدل محاسبهٔ قیمت
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="PER_GIB">به‌ازای هر گیگابایت</option>
              <option value="FIXED">بسته با قیمت ثابت</option>
              <option value="MIXED">ترکیبی</option>
            </select>
          </label>
          {mode !== 'FIXED' && (
            <label>
              قیمت هر گیگابایت (تومان، عدد صحیح)
              <input
                value={rate}
                required={mode === 'PER_GIB'}
                onChange={(e) => setRate(e.target.value)}
                placeholder="12000"
              />
            </label>
          )}
          {mode !== 'PER_GIB' && (
            <fieldset className="fixed-package-editor">
              <legend>بسته‌های دارای قیمت ثابت</legend>
              <p className="field-hint">
                حجم و قیمت را جدا وارد کنید؛ مثلاً ۵۰ گیگابایت و ۱۵۰٬۰۰۰ تومان.
              </p>
              {packageRows.map((row, index) => (
                <div className="package-row" key={index}>
                  <label>
                    حجم (گیگابایت)
                    <input
                      value={row.gib}
                      inputMode="decimal"
                      placeholder="50"
                      onChange={(e) =>
                        setPackageRows((rows) =>
                          rows.map((old, i) =>
                            i === index ? { ...old, gib: e.target.value } : old,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    قیمت (تومان)
                    <input
                      value={row.toman}
                      inputMode="numeric"
                      placeholder="150000"
                      onChange={(e) =>
                        setPackageRows((rows) =>
                          rows.map((old, i) =>
                            i === index
                              ? { ...old, toman: e.target.value }
                              : old,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary package-remove"
                    aria-label={`حذف بستهٔ شمارهٔ ${formatInteger(index + 1)}`}
                    disabled={packageRows.length === 1}
                    onClick={() =>
                      setPackageRows((rows) =>
                        rows.filter((_, i) => i !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary add-package"
                disabled={packageRows.length >= 100}
                onClick={() =>
                  setPackageRows((rows) => [...rows, { gib: '', toman: '' }])
                }
              >
                + افزودن بستهٔ دیگر
              </button>
            </fieldset>
          )}
          <label>
            زمان شروع اعتبار (UTC)
            <input
              required
              value={from}
              dir="ltr"
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            زمان پایان اعتبار (UTC؛ خالی = نامحدود)
            <input
              dir="ltr"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>
          <button disabled={loading}>ثبت نسخهٔ جدید تعرفه</button>
        </form>
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                endpoint('assignments', {
                  sourceInstanceId: source,
                  planId: assignPlan,
                  billingAdminId: assignAdmin.trim()
                    ? validAdmin(assignAdmin)
                    : null,
                  effectiveFrom: iso(from),
                  effectiveUntil: until.trim() ? iso(until) : null,
                }),
              'اختصاص طرح',
            )
          }
        >
          <span className="step-number">۰۳</span>
          <h3>اختصاص طرح</h3>
          <p className="muted">
            طرح را پیش‌فرض کنید یا به مدیر خاصی اختصاص دهید.
          </p>
          <label>
            طرح
            <select
              required
              value={assignPlan}
              onChange={(e) => setAssignPlan(e.target.value)}
            >
              <option value="">یک طرح انتخاب کنید</option>
              {config?.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (شناسهٔ {p.id})
                </option>
              ))}
            </select>
          </label>
          <label>
            شناسهٔ مدیر حساب (خالی = طرح پیش‌فرض)
            <input
              value={assignAdmin}
              onChange={(e) => setAssignAdmin(e.target.value)}
              placeholder="پیش‌فرض برای این منبع"
            />
          </label>
          <p className="muted">
            بازهٔ اعتبار از مرحلهٔ دوم گرفته می‌شود. بازه‌های هم‌پوشان پذیرفته
            نمی‌شوند.
          </p>
          <button disabled={loading}>ثبت اختصاص طرح</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void preview();
          }}
        >
          <span className="step-number">۰۴</span>
          <h3>محاسبهٔ آزمایشی هزینه</h3>
          <p className="muted">
            یک حجم دلخواه را وارد کنید؛ هیچ پرداختی انجام نمی‌شود.
          </p>
          <label>
            شناسهٔ مدیر حساب
            <input
              required
              value={quoteAdmin}
              onChange={(e) => setQuoteAdmin(e.target.value)}
            />
          </label>
          <label>
            حجم بسته (گیگابایت)
            <input
              required
              value={gib}
              onChange={(e) => setGib(e.target.value)}
              inputMode="decimal"
              placeholder="مثلاً 50"
            />
          </label>
          <label>
            زمان رویداد (UTC)
            <input
              required
              value={quoteAt}
              dir="ltr"
              onChange={(e) => setQuoteAt(e.target.value)}
            />
          </label>
          <button disabled={loading}>محاسبهٔ قیمت بدون ثبت هزینه</button>
          {quote && (
            <div role="status" className="pricing-success quote-result">
              <span>هزینهٔ محاسبه‌شده</span>
              <strong>{formatInteger(quote.amountToman)} تومان</strong>
              <span>
                {formatGiB(quote.billableBytes)} ·{' '}
                {quoteSource[quote.source] ?? quote.source}
              </span>
              <small>
                نسخهٔ {formatInteger(quote.ruleVersionId)} ·{' '}
                {modeLabel[quote.mode] ?? quote.mode}
              </small>
            </div>
          )}
        </form>
      </div>
      <h3>
        تاریخچهٔ تعرفه‌ها{' '}
        <span className="subheading">(جدیدترین نسخه ابتدا)</span>
      </h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>نسخه / طرح</th>
              <th>مدیر حساب</th>
              <th>مدل تعرفه</th>
              <th>مبلغ و حجم بسته‌ها</th>
              <th>بازهٔ اعتبار (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {config?.versions.map((v) => (
              <tr key={v.id}>
                <td>
                  نسخهٔ {formatInteger(v.id)} ·{' '}
                  {v.planId ? `طرح ${formatInteger(v.planId)}` : 'قیمت اختصاصی'}
                </td>
                <td>
                  {v.billingAdminId ? formatInteger(v.billingAdminId) : '—'}
                </td>
                <td>
                  {modeLabel[v.mode] ?? v.mode}
                  <small>
                    {formatInteger(Object.keys(v.fixedPackages).length)} بستهٔ
                    ثابت
                  </small>
                </td>
                <td>
                  {v.rateTomanPerGiB
                    ? `${formatInteger(v.rateTomanPerGiB)} تومان / گیگابایت`
                    : 'فقط قیمت بسته‌ای'}
                  {Object.entries(v.fixedPackages).map(([bytes, toman]) => (
                    <small key={bytes}>
                      {formatGiB(bytes)}: {formatInteger(toman)} تومان
                    </small>
                  ))}
                </td>
                <td>
                  {formatUtc(v.effectiveFrom)} تا{' '}
                  {v.effectiveUntil
                    ? formatUtc(v.effectiveUntil)
                    : 'بدون پایان'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>طرح‌های اختصاص‌یافته و زمان‌بندی‌شده</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>اختصاص</th>
              <th>مدیر حساب</th>
              <th>طرح</th>
              <th>بازهٔ اعتبار (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {config?.assignments.map((a) => (
              <tr key={a.id}>
                <td>{formatInteger(a.id)}</td>
                <td>
                  {a.billingAdminId
                    ? formatInteger(a.billingAdminId)
                    : 'پیش‌فرض سامانه'}
                </td>
                <td>{formatInteger(a.planId)}</td>
                <td>
                  {formatUtc(a.effectiveFrom)} تا{' '}
                  {a.effectiveUntil
                    ? formatUtc(a.effectiveUntil)
                    : 'بدون پایان'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
