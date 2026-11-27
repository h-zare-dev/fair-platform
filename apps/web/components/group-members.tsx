'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Admin = { id: string; username: string };
export function GroupMembers({
  members,
  busy,
  submit,
  remove,
}: {
  members: string[];
  busy: boolean;
  submit: (event: FormEvent<HTMLFormElement>, ids: string[]) => void;
  remove: (id: string, name?: string) => void;
}) {
  const [directory, setDirectory] = useState<Admin[]>([]);
  const [status, setStatus] = useState<'loading' | 'available' | 'failed'>(
    'loading',
  );
  const [attempt, retry] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const master = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      const admins = new Map<string, Admin>();
      let total: number | null = null;
      do {
        const offset = admins.size;
        const res = await fetch(
          `/api/v1/owner/directory/admins?offset=${offset}&limit=50`,
          { cache: 'no-store', signal: controller.signal },
        );
        if (res.status === 401) window.location.assign('/login');
        if (!res.ok) throw new Error();
        const page = (await res.json()) as {
          admins: Admin[];
          total: number;
          offset: number;
        };
        if (
          (total !== null && total !== page.total) ||
          page.offset !== offset ||
          (!page.admins.length && offset < page.total)
        )
          throw new Error();
        total = page.total;
        for (const admin of page.admins) {
          if (admins.has(admin.id)) throw new Error();
          admins.set(admin.id, admin);
        }
      } while (admins.size < total);
      if (admins.size !== total) throw new Error();
      if (!controller.signal.aborted) {
        setDirectory([...admins.values()]);
        setStatus('available');
      }
    }
    void read().catch(() => {
      if (!controller.signal.aborted) setStatus('failed');
    });
    return () => controller.abort();
  }, [attempt]);
  const current = new Set(members);
  const names = new Map(directory.map((a) => [a.id, a.username]));
  const needle = search.trim().toLowerCase();
  const matches = (id: string) =>
    (names.get(id) ?? '').toLowerCase().includes(needle) || id.includes(needle);
  const available = directory.filter(
    (a) => !current.has(a.id) && matches(a.id),
  );
  const chosen = new Set(selected.filter((id) => !current.has(id)));
  const checked = available.filter((a) => chosen.has(a.id)).length;
  useEffect(() => {
    if (master.current)
      master.current.indeterminate = checked > 0 && checked < available.length;
  }, [checked, available.length]);
  return (
    <form
      className="group-transfer"
      onSubmit={(event) => submit(event, [...chosen])}
    >
      <label>
        جست‌وجوی نام یا شناسهٔ مدیر
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {status === 'loading' && <p role="status">در حال دریافت نام مدیران…</p>}
      {status === 'failed' && (
        <p role="alert">
          فهرست پاسارگارد در دسترس نیست (DIRECTORY_UNAVAILABLE).{' '}
          <button
            type="button"
            onClick={() => {
              setStatus('loading');
              retry((v) => v + 1);
            }}
          >
            تلاش دوباره
          </button>
        </p>
      )}
      <div className="transfer-columns">
        <section aria-label="مدیران قابل افزودن">
          <h3>مدیران قابل افزودن ({available.length})</h3>
          <label className="transfer-choice">
            <input
              ref={master}
              type="checkbox"
              checked={available.length > 0 && checked === available.length}
              disabled={!available.length || busy}
              onChange={(e) => {
                for (const a of available) {
                  if (e.target.checked) chosen.add(a.id);
                  else chosen.delete(a.id);
                }
                setSelected([...chosen]);
              }}
            />
            {needle ? 'انتخاب همهٔ نتایج' : 'انتخاب همهٔ مدیران'}
          </label>
          <div className="transfer-list">
            {available.map((a) => (
              <label className="transfer-choice" key={a.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={chosen.has(a.id)}
                  onChange={(e) => {
                    if (e.target.checked) chosen.add(a.id);
                    else chosen.delete(a.id);
                    setSelected([...chosen]);
                  }}
                />
                <span>
                  <bdi>{a.username}</bdi> <small>#{a.id}</small>
                </span>
              </label>
            ))}
          </div>
          <button disabled={busy || !chosen.size || status !== 'available'}>
            افزودن به گروه{chosen.size ? ' (' + chosen.size + ')' : ''} ←
          </button>
        </section>
        <section aria-label="اعضای گروه">
          <h3>اعضای گروه ({members.length})</h3>
          <div className="transfer-list">
            {members.filter(matches).map((id) => (
              <div className="transfer-member" key={id}>
                <span>
                  <bdi>
                    {names.get(id) ??
                      (status === 'available' ? 'نام در فهرست موجود نیست' : '')}
                  </bdi>{' '}
                  <small>#{id}</small>
                </span>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  aria-label={`حذف ${names.get(id) ?? id} از گروه`}
                  onClick={() => remove(id, names.get(id))}
                >
                  حذف
                </button>
              </div>
            ))}
            {!members.length && <p>گروه هنوز عضوی ندارد.</p>}
          </div>
        </section>
      </div>
    </form>
  );
}
