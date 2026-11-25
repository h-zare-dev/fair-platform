'use client';

import { useState, type FormEvent } from 'react';

export function ChangePassword() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const currentPassword = field('currentPassword');
    const newPassword = field('newPassword');
    const confirmation = field('confirmation');
    if (newPassword !== confirmation) {
      setError('تکرار رمز جدید مطابقت ندارد.');
      return;
    }
    if (
      newPassword.length < 8 ||
      !/[A-Za-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword)
    ) {
      setError('رمز جدید باید حداقل ۸ کاراکتر و شامل حرف انگلیسی و عدد باشد.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/v1/owner/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Fair-CSRF': '1' },
        body: JSON.stringify({ currentPassword, newPassword }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        form.reset();
        window.location.assign('/login');
        return;
      }
      setError(
        response.status === 429
          ? 'تعداد تلاش‌ها زیاد است؛ یک دقیقه صبر کنید.'
          : response.status === 401
            ? 'رمز فعلی اشتباه است یا نشست شما منقضی شده است.'
            : 'تغییر رمز انجام نشد. دوباره تلاش کنید.',
      );
    } catch {
      setError('ارتباط برقرار نشد. دوباره تلاش کنید.');
    } finally {
      form.reset();
      setBusy(false);
    }
  }

  return (
    <section className="password-settings" aria-labelledby="password-heading">
      <h2 id="password-heading">تغییر رمز عبور</h2>
      <p className="muted">
        رمز جدید حداقل ۸ کاراکتر و شامل حرف انگلیسی و عدد باشد. بعد از تغییر،
        باید دوباره وارد شوید.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="current-password">رمز عبور فعلی</label>
        <input
          id="current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          maxLength={1024}
          required
          disabled={busy}
        />
        <label htmlFor="new-password">رمز عبور جدید</label>
        <input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={1024}
          required
          disabled={busy}
        />
        <label htmlFor="confirm-password">تکرار رمز عبور جدید</label>
        <input
          id="confirm-password"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={1024}
          required
          disabled={busy}
        />
        <p className="error" role="alert">
          {error}
        </p>
        <button type="submit" disabled={busy}>
          {busy ? 'در حال تغییر…' : 'تغییر رمز عبور'}
        </button>
      </form>
    </section>
  );
}
