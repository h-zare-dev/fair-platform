'use client';
import { useState, type FormEvent } from 'react';
export function Login() {
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
      if (r.ok) {
        window.location.assign('/dashboard');
        return;
      }
      setError(
        r.status === 429
          ? 'Too many attempts. Please wait a minute.'
          : r.status === 401
            ? 'Unable to sign in. Check your password.'
            : 'Sign in is unavailable. Please try again.',
      );
    } catch {
      form.reset();
      setError('Sign in is unavailable. Please try again.');
    }
    setBusy(false);
  }
  return (
    <form
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <label htmlFor="password">Owner password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        maxLength={1024}
        required
        disabled={busy}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in →'}
      </button>
      <p role="alert" className="error">
        {error}
      </p>
    </form>
  );
}
