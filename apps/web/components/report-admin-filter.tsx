'use client';

import { useEffect, useState } from 'react';
import { useReportPopoverDismiss } from '../lib/use-report-popover-dismiss';

type AdminOption = {
  billingAdminId: string;
  adminName: string | null;
  nameStatus: string;
};
type AdminPage = {
  rows: AdminOption[];
  nextOffset: number | null;
};

function verifiedName(admin: AdminOption): string {
  const name = admin.adminName;
  if (name && !/^anon-[0-9a-f]{8,64}$/i.test(name)) return name;
  return `نام مدیر تأیید نشده (شناسهٔ ${admin.billingAdminId})`;
}

export function ReportAdminFilter({
  runId,
  selectedId,
  selectedName,
  onSelect,
}: {
  runId: string;
  selectedId: string;
  selectedName: string;
  onSelect: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AdminPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { containerRef, triggerRef } = useReportPopoverDismiss(open, setOpen);

  useEffect(() => {
    if (!open || !runId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      runId,
      search,
      offset: String(offset),
      limit: '25',
    });
    setBusy(true);
    setData(null);
    setError('');
    void fetch(
      `/api/v1/owner/operations/accounting/replay-shadow/audit/admins?${params}`,
      {
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign('/login');
          throw new Error('نشست Owner منقضی شده است.');
        }
        if (!response.ok) throw new Error('فهرست مدیران در دسترس نیست.');
        return response.json() as Promise<AdminPage>;
      })
      .then((page) => {
        if (!controller.signal.aborted) setData(page);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : 'خطای فهرست مدیران',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [open, runId, search, offset]);

  return (
    <div className="report-admin-filter" ref={containerRef}>
      <span className="report-filter-label">مدیر</span>
      <button
        type="button"
        ref={triggerRef}
        className="secondary report-admin-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        {selectedId ? selectedName || 'نام مدیر تأیید نشده' : 'همهٔ مدیران'} ▾
      </button>
      {open && (
        <div
          className="report-admin-popover"
          role="dialog"
          aria-label="فیلتر گزارش بر اساس مدیر"
        >
          <input
            type="search"
            aria-label="جست‌وجوی نام مدیر"
            value={search}
            maxLength={64}
            placeholder="جست‌وجوی نام مدیر"
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
          <div className="report-admin-results">
            <button
              type="button"
              className={!selectedId ? 'report-admin-selected' : 'secondary'}
              onClick={() => {
                onSelect('', '');
                setOpen(false);
              }}
            >
              همهٔ مدیران
            </button>
            {data?.rows.map((admin) => (
              <button
                type="button"
                key={admin.billingAdminId}
                className={
                  selectedId === admin.billingAdminId
                    ? 'report-admin-selected'
                    : 'secondary'
                }
                onClick={() => {
                  onSelect(admin.billingAdminId, verifiedName(admin));
                  setOpen(false);
                }}
              >
                {verifiedName(admin)}
              </button>
            ))}
          </div>
          {busy && (
            <p className="muted" role="status">
              در حال دریافت مدیران…
            </p>
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {data && !data.rows.length && (
            <p className="muted">مدیری با این نام پیدا نشد.</p>
          )}
          <div className="report-admin-pager">
            <button
              type="button"
              className="secondary"
              disabled={offset === 0 || busy}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              قبلی
            </button>
            <button
              type="button"
              className="secondary"
              disabled={data?.nextOffset == null || busy}
              onClick={() => setOffset(data!.nextOffset!)}
            >
              بعدی
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setOpen(false)}
            >
              بستن
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
