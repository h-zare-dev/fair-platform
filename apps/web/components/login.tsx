'use client';
import { useEffect, useState, type FormEvent } from 'react';
export function Login() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = e.currentTarget;
    const field = new FormData(form).get('password');
    const password = typeof field === 'string' ? field : '';
    try {
      const r = await fetch('/api/v1/owner/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(10000),
      });
      form.reset();
      const result: unknown = await r.json();
      if (
        r.ok &&
        typeof result === 'object' &&
        result !== null &&
        'authenticated' in result &&
        result.authenticated === true
      ) {
        window.location.assign('/dashboard');
        return;
      }
      setError(
        r.status === 429
          ? 'تعداد تلاش‌ها بیش از حد مجاز است. کمی صبر کنید.'
          : r.status === 401
            ? 'ورود انجام نشد. گذرواژه را بررسی کنید.'
            : 'ورود در دسترس نیست. دوباره تلاش کنید.',
      );
    } catch {
      form.reset();
      setError('ورود در دسترس نیست. دوباره تلاش کنید.');
    }
    setBusy(false);
  }
  return (
    <form
      method="post"
      action="/api/v1/owner/auth/login"
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <label htmlFor="password">گذرواژهٔ مدیر اصلی</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        maxLength={1024}
        required
        disabled={!ready || busy}
      />
      <button type="submit" disabled={!ready || busy}>
        {!ready
          ? 'آماده‌سازی ورود…'
          : busy
            ? 'در حال ورود…'
            : 'ورود به داشبورد ←'}
      </button>
      <p hidden={ready}>برای ورود امن باید جاوااسکریپت فعال باشد.</p>
      <p role="alert" className="error">
        {error}
      </p>
    </form>
  );
}
