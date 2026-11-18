'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

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
  if (!v.trim()) throw Error('UTC timestamp is required.');
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw Error('Invalid UTC timestamp.');
  return d.toISOString();
};
function fixedCatalog(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!text.trim()) return result;
  const entries = text.split(',');
  if (entries.length > 100) throw Error('Maximum 100 fixed packages.');
  for (const entry of entries) {
    const parts = entry.trim().split(':');
    if (
      parts.length !== 2 ||
      !parts.every((v) => numeric.test(v.trim()) && v.trim() !== '0')
    )
      throw Error('Use bytes:toman, bytes:toman (positive integers).');
    const key = parts[0].trim();
    if (Object.hasOwn(result, key)) throw Error('Duplicate package bytes.');
    result[key] = parts[1].trim();
  }
  return result;
}
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
    throw Error('Owner session expired.');
  }
  if (!response.ok)
    throw Error(
      `Pricing request rejected (${response.status}). Check dates, access, and conflicts.`,
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
  const [packages, setPackages] = useState('');
  const [from, setFrom] = useState('2026-12-01T00:00:00Z');
  const [until, setUntil] = useState('2027-01-01T00:00:00Z');
  const [assignAdmin, setAssignAdmin] = useState('');
  const [assignPlan, setAssignPlan] = useState('');
  const [bytes, setBytes] = useState('1073741824');
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
      setNotice(`${label} saved. Existing history remains immutable.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
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
    if (!numeric.test(v))
      throw Error('Admin ID must be a nonnegative integer.');
    return v;
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
        billableBytes: bytes,
        purpose: 'FULL_PACKAGE',
      });
      setQuote(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="pricing-card" aria-label="Pricing configuration">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FP-004 / SHADOW ONLY</p>
          <h2>Pricing configuration</h2>
        </div>
        <span className="badge">OWNER ONLY</span>
      </div>
      <p className="muted">
        Configuration and synthetic quotes only. No ledger charge or live
        billing. Effective windows are UTC and half-open [from, until).
      </p>
      <label>
        Pricing source ID{' '}
        <input
          value={source}
          maxLength={100}
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
              'Plan',
            )
          }
        >
          <h3>1. Create plan</h3>
          <label>
            Plan name{' '}
            <input
              required
              maxLength={100}
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              placeholder="Standard"
            />
          </label>
          <button disabled={loading}>Create plan</button>
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
                    mode === 'FIXED' ? null : rate.trim() || null,
                  fixedPackages: fixedCatalog(packages),
                  effectiveFrom: iso(from),
                  effectiveUntil: until.trim() ? iso(until) : null,
                }),
              'Rule version',
            )
          }
        >
          <h3>2. Add immutable rule version</h3>
          <label>
            Rule for{' '}
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="plan">Plan</option>
              <option value="override">Billing Admin override</option>
            </select>
          </label>
          {target === 'plan' ? (
            <label>
              Plan{' '}
              <select
                required
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">Choose plan</option>
                {config?.plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (#{p.id})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Billing Admin ID{' '}
              <input
                required
                value={adminId}
                onChange={(e) => setAdminId(e.target.value)}
                placeholder="9001"
              />
            </label>
          )}
          <label>
            Mode{' '}
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="PER_GIB">Per GiB</option>
              <option value="FIXED">Fixed exact bytes</option>
              <option value="MIXED">Mixed</option>
            </select>
          </label>
          {mode !== 'FIXED' && (
            <label>
              Toman per GiB (integer){' '}
              <input
                value={rate}
                required={mode === 'PER_GIB'}
                onChange={(e) => setRate(e.target.value)}
                placeholder="12000"
              />
            </label>
          )}
          {mode !== 'PER_GIB' && (
            <label>
              Fixed packages: bytes:toman, ...{' '}
              <textarea
                rows={2}
                value={packages}
                onChange={(e) => setPackages(e.target.value)}
                placeholder="1073741824:12000, 2147483648:22000"
              />
            </label>
          )}
          <label>
            Effective from (UTC){' '}
            <input
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Effective until (UTC; blank = infinity){' '}
            <input value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <button disabled={loading}>Save new rule version</button>
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
              'Assignment',
            )
          }
        >
          <h3>3. Assign plan</h3>
          <label>
            Plan{' '}
            <select
              required
              value={assignPlan}
              onChange={(e) => setAssignPlan(e.target.value)}
            >
              <option value="">Choose plan</option>
              {config?.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (#{p.id})
                </option>
              ))}
            </select>
          </label>
          <label>
            Billing Admin ID (blank = default plan){' '}
            <input
              value={assignAdmin}
              onChange={(e) => setAssignAdmin(e.target.value)}
              placeholder="Default for this source"
            />
          </label>
          <p className="muted">
            Uses effective dates in step 2. Overlapping assignments are
            rejected.
          </p>
          <button disabled={loading}>Save assignment</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void preview();
          }}
        >
          <h3>4. Synthetic quote preview</h3>
          <label>
            Billing Admin ID{' '}
            <input
              required
              value={quoteAdmin}
              onChange={(e) => setQuoteAdmin(e.target.value)}
            />
          </label>
          <label>
            Billable bytes{' '}
            <input
              required
              value={bytes}
              onChange={(e) => setBytes(e.target.value)}
            />
          </label>
          <label>
            Source timestamp UTC{' '}
            <input
              required
              value={quoteAt}
              onChange={(e) => setQuoteAt(e.target.value)}
            />
          </label>
          <button disabled={loading}>Preview, do not charge</button>
          {quote && (
            <p role="status" className="pricing-success">
              <strong>{quote.amountToman} Toman</strong> · {quote.source} ·
              version #{quote.ruleVersionId} · {quote.mode}
            </p>
          )}
        </form>
      </div>
      <h3>Persisted rules (latest first, source-scoped)</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Version / plan</th>
              <th>Admin</th>
              <th>Mode</th>
              <th>Rate</th>
              <th>Effective UTC</th>
            </tr>
          </thead>
          <tbody>
            {config?.versions.map((v) => (
              <tr key={v.id}>
                <td>
                  #{v.id} · {v.planId ?? 'Override'}
                </td>
                <td>{v.billingAdminId ?? '—'}</td>
                <td>
                  {v.mode}
                  <small>
                    {Object.keys(v.fixedPackages).length} fixed prices
                  </small>
                </td>
                <td>{v.rateTomanPerGiB ?? 'Exact only'}</td>
                <td>
                  {v.effectiveFrom} → {v.effectiveUntil ?? '∞'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Active and scheduled assignments</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Billing Admin</th>
              <th>Plan</th>
              <th>Effective UTC</th>
            </tr>
          </thead>
          <tbody>
            {config?.assignments.map((a) => (
              <tr key={a.id}>
                <td>#{a.id}</td>
                <td>{a.billingAdminId ?? 'System default'}</td>
                <td>#{a.planId}</td>
                <td>
                  {a.effectiveFrom} → {a.effectiveUntil ?? '∞'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
