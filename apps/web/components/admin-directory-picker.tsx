'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

type Admin = { id: string; username: string };
type Result = {
  status: 'available';
  admins: Admin[];
  total: number;
  offset: number;
  limit: number;
};

export function AdminDirectoryPicker({
  value,
  onChange,
  setLabels,
}: {
  value: string;
  onChange: (value: string) => void;
  setLabels: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const limit = 25;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        search: search.trim(),
        offset: String(page * limit),
        limit: String(limit),
      });
      void fetch(`/api/v1/owner/directory/admins?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 401) {
            window.location.assign('/login');
            throw new Error('Session expired');
          }
          if (!response.ok) throw new Error('Directory unavailable');
          return response.json() as Promise<Result>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          setResult(data);
          setState('ready');
          setLabels((previous) => {
            const next = { ...previous };
            for (const admin of data.admins) next[admin.id] = admin.username;
            return next;
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResult(null);
            setState('unavailable');
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search, page, setLabels]);

  return (
    <section className="admin-directory">
      <label>
        جست‌وجو در فهرست مدیران پاسارگاد
        <input
          type="search"
          value={search}
          maxLength={64}
          placeholder="جست‌وجوی نام مدیر"
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
            setResult(null);
            setState('loading');
          }}
        />
      </label>
      {state === 'unavailable' && (
        <p className="catalog-note" role="status">
          فهرست مدیران فعلاً در دسترس نیست (DIRECTORY_UNAVAILABLE). می‌توانید
          شناسهٔ مدیر را پایین به‌صورت دستی وارد کنید؛ این شناسه تا زمان اتصال
          مجدد با پاسارگاد تطبیق داده نمی‌شود.
        </p>
      )}
      {state === 'loading' && (
        <p className="field-hint">در حال دریافت فهرست…</p>
      )}
      {state === 'ready' && (
        <>
          <div className="catalog-member-list admin-directory-results">
            {result?.admins.length ? (
              result.admins.map((admin) => (
                <button
                  className={
                    value === admin.id
                      ? 'admin-directory-selected'
                      : 'secondary'
                  }
                  key={admin.id}
                  type="button"
                  onClick={() => onChange(admin.id)}
                  aria-pressed={value === admin.id}
                >
                  <span>{admin.username}</span>
                  <span dir="ltr">({admin.id})</span>
                </button>
              ))
            ) : (
              <p className="field-hint">مدیری با این جست‌وجو پیدا نشد.</p>
            )}
          </div>
          {result && result.total > limit && (
            <div className="admin-directory-pagination">
              <button
                type="button"
                className="secondary"
                disabled={page === 0}
                onClick={() => {
                  setPage((v) => v - 1);
                  setState('loading');
                }}
              >
                قبلی
              </button>
              <span>
                {page + 1} / {Math.ceil(result.total / limit)}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={(page + 1) * limit >= result.total}
                onClick={() => {
                  setPage((v) => v + 1);
                  setState('loading');
                }}
              >
                بعدی
              </button>
            </div>
          )}
        </>
      )}
      <label>
        شناسهٔ مدیر انتخاب‌شده (امکان ورود دستی)
        <input
          required
          inputMode="numeric"
          dir="ltr"
          placeholder="9001"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </section>
  );
}
