'use client';
import { useEffect, useState } from 'react';
interface Summary {
  pendingBatches: string;
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
  resolved: boolean;
}
interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}
const utc = (value: string) =>
  value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`/api/v1/owner/${path}`, {
    cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(10000),
  });
  if (r.status === 401) {
    window.location.assign('/login');
    throw new Error('Session expired');
  }
  if (!r.ok) throw new Error('Operations unavailable. Please try again.');
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
        <span className="badge">SYNTHETIC</span>
      </div>
      {empty ? (
        <p className="empty">No records in this range.</p>
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
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10000);
    setBusy(true);
    setError('');
    setSummary(null);
    setEvents({ rows: [], nextCursor: null });
    setIssues({ rows: [], nextCursor: null });
    const params = new URLSearchParams({
      window: windowRange,
      ...(source ? { source } : {}),
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
          setError('Operations unavailable. Counts could not be loaded.');
      } finally {
        clearTimeout(timeout);
        if (!abort.signal.aborted) setBusy(false);
      }
    })();
    // Report a bounded timeout rather than leaving loading active indefinitely.
    const onAbort = () => {
      setBusy(false);
      setError('Request timed out. Please try again.');
    };
    abort.signal.addEventListener('abort', onAbort);
    return () => {
      abort.signal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      abort.abort();
    };
  }, [windowRange, source, refresh]);
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
      setError('Could not load the next page. Please try again.');
    } finally {
      setPageBusy(false);
    }
  }
  async function logout() {
    setError('');
    try {
      const r = await fetch('/api/v1/owner/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok || r.status === 401) window.location.assign('/login');
      else setError('Could not sign out. Please try again.');
    } catch {
      setError('Could not sign out. Please try again.');
    }
  }
  const cards = [
    ['Received batches', summary?.receivedBatches, 'Distinct stored batches'],
    [
      'Normalized events',
      summary?.normalizedEvents,
      'Distinct rows created in range',
    ],
    [
      'Open ingestion issues',
      summary?.openIngestionIssues,
      'Created in range, still open',
    ],
    [
      'Failed batches',
      summary?.failedBatches,
      'Retryable + permanent, at query time',
    ],
  ];
  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          fair<span> / Owner</span>
        </div>
        <button
          className="secondary"
          onClick={() => {
            void logout();
          }}
        >
          Sign out ↗
        </button>
      </header>
      <main className="dashboard">
        <div className="stage">
          STAGING / SYNTHETIC / SHADOW / NO LIVE BILLING
        </div>
        <div className="intro">
          <div>
            <p className="eyebrow">WORKSPACE OVERVIEW</p>
            <h1>Operations</h1>
            <p className="muted">
              A clear view of ingestion. All times in UTC.
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy || pageBusy}
            onClick={() => setRefresh((v) => v + 1)}
          >
            ↻ Refresh
          </button>
        </div>
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setSource(sourceDraft);
          }}
        >
          <label>
            Time range
            <select
              value={windowRange}
              disabled={pageBusy}
              onChange={(e) => setWindowRange(e.target.value)}
            >
              <option value="1h">Last hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <label>
            Source instance
            <input
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
              placeholder="All sources"
              maxLength={100}
              pattern="[A-Za-z0-9_.\-]+"
            />
          </label>
          <button className="secondary" disabled={busy || pageBusy}>
            Apply source
          </button>
        </form>
        {error && (
          <div className="error-banner" role="alert">
            {error}{' '}
            <button
              className="secondary"
              onClick={() => setRefresh((v) => v + 1)}
            >
              Retry
            </button>
          </div>
        )}
        <div className="kpis" aria-busy={busy}>
          {cards.map(([name, count, description]) => (
            <section className="kpi" key={name}>
              <h2>{name}</h2>
              <p className="number">{busy ? '…' : (count ?? '—')}</p>
              <p className="muted">{description}</p>
            </section>
          ))}
        </div>
        {busy ? (
          <p role="status" className="empty">
            Loading operations…
          </p>
        ) : (
          summary && (
            <>
              <p className="range">
                Pending batches in range: {summary.pendingBatches}. Failed
                batches in range: {summary.failedBatches}.<br />
                {utc(summary.start)} → {utc(summary.end)} · Half-open interval
                [start, end)
              </p>
              <DataTable
                title="Recent normalized events"
                empty={!events.rows.length}
              >
                <table>
                  <thead>
                    <tr>
                      {[
                        'Action / user',
                        'Source time / first seen',
                        'Package / owner',
                        'Status / actor',
                        'Occurrences',
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {events.rows.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <strong>{e.action}</strong>
                          <small>
                            User {e.externalUserId} · {e.userStatus}
                          </small>
                        </td>
                        <td>
                          {utc(e.sourceTimestamp)}
                          <small>Seen {utc(e.firstSeenAt)}</small>
                        </td>
                        <td>
                          {e.dataLimitBytes} bytes
                          <small>Billing Admin {e.billingAdminId}</small>
                        </td>
                        <td>
                          {e.eventStatus}
                          <small>Actor {e.actorStatus}</small>
                        </td>
                        <td>{e.occurrenceCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
              <div className="pagination">
                <span>
                  Ordered by source event time. Accounting-ready does not mean
                  charged.
                </span>
                {events.nextCursor && (
                  <button
                    className="secondary"
                    disabled={pageBusy}
                    onClick={() => {
                      void next('events');
                    }}
                  >
                    Next events →
                  </button>
                )}
              </div>
              <DataTable
                title="Recent ingestion issues"
                empty={!issues.rows.length}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Issue</th>
                      <th>Created (UTC)</th>
                      <th>Batch index</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.rows.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <strong>{i.code}</strong>
                          <small>{i.message}</small>
                        </td>
                        <td>{utc(i.createdAt)}</td>
                        <td>{i.batchIndex ?? '—'}</td>
                        <td>{i.resolved ? 'Resolved' : 'Open'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
              <div className="pagination">
                <span>
                  Fixed safe messages. Source payloads are never shown.
                </span>
                {issues.nextCursor && (
                  <button
                    className="secondary"
                    disabled={pageBusy}
                    onClick={() => {
                      void next('issues');
                    }}
                  >
                    Next issues →
                  </button>
                )}
              </div>
            </>
          )
        )}
        <footer>
          Fair Platform · Synthetic operations only · No live source connection
        </footer>
      </main>
    </>
  );
}
