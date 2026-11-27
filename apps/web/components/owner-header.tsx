'use client';

import { useState } from 'react';
import { ThemeToggle } from './theme-toggle';

export function OwnerHeader({
  active,
}: {
  active: 'dashboard' | 'reports' | 'settings';
}) {
  const [error, setError] = useState('');
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
      else setError('خروج از حساب انجام نشد؛ دوباره تلاش کنید.');
    } catch {
      setError('خروج از حساب انجام نشد؛ دوباره تلاش کنید.');
    }
  }
  return (
    <>
      <header className="topbar">
        <a className="wordmark owner-home-link" href="/dashboard">
          <span className="brand-mark" aria-hidden="true">
            ف
          </span>
          <span className="brand-text">
            فِیر پلتفرم<small>پنل مدیریت</small>
          </span>
        </a>
        <nav className="owner-main-nav" aria-label="ناوبری اصلی">
          <a
            aria-current={active === 'dashboard' ? 'page' : undefined}
            href="/dashboard"
          >
            داشبورد
          </a>
          <a
            aria-current={active === 'reports' ? 'page' : undefined}
            href="/reports"
          >
            گزارش‌ها
          </a>
          <a
            aria-current={active === 'settings' ? 'page' : undefined}
            href="/settings/packages"
          >
            تنظیمات
          </a>
        </nav>
        <div className="topbar-actions">
          <ThemeToggle />
          <button className="secondary" onClick={() => void logout()}>
            خروج از حساب
          </button>
        </div>
      </header>
      {error && (
        <p className="error-banner owner-header-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
