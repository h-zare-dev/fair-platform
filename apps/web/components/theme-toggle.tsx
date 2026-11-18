'use client';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const storageKey = 'fair-owner-theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(storageKey);
    } catch {
      // Theme must remain usable if local storage is disabled.
    }
    const selected: Theme =
      saved === 'light' || saved === 'dark'
        ? saved
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.dataset.theme = selected;
    setTheme(selected);
  }, []);
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // A preference is never required to operate the dashboard.
    }
  }
  return (
    <button
      type="button"
      className="theme-toggle secondary"
      aria-label={theme === 'dark' ? 'فعال‌کردن تم روشن' : 'فعال‌کردن تم تاریک'}
      aria-pressed={theme === 'dark'}
      onClick={toggle}
    >
      <span aria-hidden="true" className="theme-icon">
        {theme === 'dark' ? '☀' : '☾'}
      </span>
      <span>{theme === 'dark' ? 'تم روشن' : 'تم تاریک'}</span>
    </button>
  );
}
