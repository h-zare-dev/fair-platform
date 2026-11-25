'use client';
import { useEffect, useState } from 'react';
import { rememberOwnerSource } from '../lib/owner-source';

export function WebhookSettings() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    setUrl(new URL('/api/v1/owner/webhook/pasarguard', location.origin).href);
  }, []);

  async function copy(secret: boolean) {
    setStatus('');
    try {
      let value = url;
      if (secret) {
        const response = await fetch(
          '/api/v1/owner/settings/webhook/credential',
          {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'x-fair-csrf': '1' },
            body: '{}',
          },
        );
        if (response.status === 401) {
          location.assign('/login');
          return;
        }
        if (!response.ok) {
          setStatus(
            response.status === 503
              ? 'رمز وب‌هوک روی سرور تنظیم نشده است.'
              : 'دریافت رمز ناموفق بود.',
          );
          return;
        }
        const credential: unknown = await response.json();
        if (
          typeof credential !== 'object' ||
          credential === null ||
          !('secret' in credential) ||
          typeof credential.secret !== 'string' ||
          !credential.secret
        ) {
          setStatus('پاسخ سرور شامل رمز وب‌هوک معتبر نیست.');
          return;
        }
        value = credential.secret;
      }
      await navigator.clipboard.writeText(value);
      setStatus(secret ? 'رمز وب‌هوک کپی شد.' : 'آدرس وب‌هوک کپی شد.');
    } catch {
      setStatus('کپی انجام نشد. دسترسی مرورگر به کلیپ‌بورد را بررسی کنید.');
    }
  }
  return (
    <section className="table-card">
      <h2>وب‌هوک پاسارگارد</h2>
      <p>
        در پاسارگارد یک وب‌هوک دوم اضافه کنید و آدرس و رمز زیر را وارد کنید.
      </p>
      <input aria-label="آدرس وب‌هوک" dir="ltr" readOnly value={url} />
      <button disabled={!url} onClick={() => void copy(false)}>
        کپی آدرس
      </button>
      <button onClick={() => void copy(true)}>کپی رمز وب‌هوک</button>
      <p role="status">{status}</p>
      <a href="/dashboard" onClick={() => rememberOwnerSource('primary')}>
        مشاهدهٔ رویدادهای وب‌هوک در داشبورد
      </a>
    </section>
  );
}
