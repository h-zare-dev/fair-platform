'use client';
import { useState } from 'react';

const EXPECTED_SHA =
  'fa845d0a2276e65ff7ca4c77fc253c289309541ed3367d752ab3ee4af190e242';
const EXPECTED_GROUPS = 15914;
const EXPECTED_CHILDREN = 64135;
const MAX_REQUEST_BYTES = 180000; // Below Caddy's 256 KiB webhook limit.
const encoder = new TextEncoder();

interface RecordLine {
  received_at: string;
  payload: Record<string, unknown>[];
  legacy_stored_rows: number;
}
interface RecordUpload {
  receivedAt: string;
  payload: Record<string, unknown>[];
}

function chunksFor(lines: string[]): string[] {
  const chunks: string[] = [];
  let items: RecordUpload[] = [];
  let groups = 0;
  let children = 0;
  const flush = () => {
    if (items.length) chunks.push(JSON.stringify({ records: items }));
    items = [];
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as RecordLine;
    if (
      !item ||
      typeof item.received_at !== 'string' ||
      !Array.isArray(item.payload) ||
      item.payload.length === 0 ||
      !item.payload.every(
        (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
      ) ||
      !Number.isSafeInteger(item.legacy_stored_rows) ||
      item.legacy_stored_rows !== item.payload.length
    )
      throw new Error('قالب آرشیو معتبر نیست.');
    const entry = { receivedAt: item.received_at, payload: item.payload };
    if (
      encoder.encode(JSON.stringify({ records: [...items, entry] }))
        .byteLength > MAX_REQUEST_BYTES ||
      items.length === 100
    )
      flush();
    if (
      encoder.encode(JSON.stringify({ records: [entry] })).byteLength >
      MAX_REQUEST_BYTES
    )
      throw new Error('یک دسته از محدودیت امن دریافت بزرگ‌تر است.');
    items.push(entry);
    groups++;
    children += item.payload.length;
  }
  flush();
  if (groups !== EXPECTED_GROUPS || children !== EXPECTED_CHILDREN)
    throw new Error('تعداد رویدادها با خروجی تأییدشده مطابقت ندارد.');
  return chunks;
}

export function ReplayImport() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState('');
  async function upload(file: File) {
    if (running) return;
    setRunning(true);
    setMessage('در حال بررسی یکپارچگی آرشیو…');
    setDone(0);
    try {
      if (file.size > 6 * 1024 * 1024)
        throw new Error('این فایل خروجی مورد انتظار نیست.');
      const bytes = await file.arrayBuffer();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      )
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      if (digest !== EXPECTED_SHA)
        throw new Error('اثر انگشت آرشیو با نسخهٔ ۳۰روزهٔ تأییدشده یکسان نیست.');
      const clear = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
      const records = await new Response(clear).text();
      const chunks = chunksFor(records.split('\n'));
      setTotal(chunks.length);
      setMessage(
        'در حال واردکردن دسته‌ها؛ داده‌ها فقط برای نمایش و پردازش آزمایشی هستند…',
      );
      let next = 0;
      let completed = 0;
      async function worker() {
        for (;;) {
          const index = next++;
          if (index >= chunks.length) return;
          const response = await fetch('/api/v1/owner/webhook/pasarguard', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/json',
              'x-fair-csrf': '1',
              'x-fair-replay-import': EXPECTED_SHA,
            },
            body: chunks[index],
          });
          if (!response.ok) {
            if (response.status === 401) window.location.assign('/login');
            throw new Error(
              `ثبت دستهٔ ${index + 1} متوقف شد (${response.status}). می‌توانید دوباره همان فایل را انتخاب کنید.`,
            );
          }
          completed++;
          setDone(completed);
        }
      }
      await Promise.all(Array.from({ length: 3 }, () => worker()));
      setMessage(
        'ورود همهٔ ۱۵٬۹۱۴ دسته انجام شد. پردازش در پس‌زمینه ادامه دارد. از فیلتر «آرشیو واقعی ۳۰روزه» استفاده کنید.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'ورود آرشیو متوقف شد.',
      );
    } finally {
      setRunning(false);
    }
  }
  return (
    <section className="table-card" aria-label="ورود خروجی سی روزه">
      <div className="section-heading">
        <h2>ورود آرشیو ۳۰روزهٔ ربات قبلی</h2>
        <span className="badge">فقط دریافت و پردازش، بدون حسابداری</span>
      </div>
      <p className="muted">
        فقط فایل تأییدشدهٔ ۶۴٬۱۳۵ رویدادی پذیرفته می‌شود. منبع «replay-30d» مستقل
        از پاسارگاد زنده است؛ وبهوک قدیمی و محاسبات مالی تغییر نمی‌کنند.
      </p>
      <input
        type="file"
        accept=".gz,application/gzip"
        disabled={running}
        aria-label="انتخاب آرشیو ۳۰روزه"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
      />
      {total > 0 && (
        <progress value={done} max={total} aria-label="پیشرفت بارگذاری" />
      )}
      {message && (
        <p role="status" className="muted">
          {message}
          {running && total > 0 ? ` (${done} از ${total})` : ''}
        </p>
      )}
    </section>
  );
}
