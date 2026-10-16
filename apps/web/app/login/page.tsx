import { redirect } from 'next/navigation';
import { ownerSession } from '../../lib/session';
import { Login } from '../../components/login';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  if ((await ownerSession()) === 'authenticated') redirect('/dashboard');
  return (
    <main className="login-shell">
      <div className="wordmark">
        fair<span> / Owner</span>
      </div>
      <div className="login-card">
        <p className="eyebrow">PRIVATE OPERATIONS</p>
        <h1>Welcome back.</h1>
        <p className="muted">Sign in to view your staging operations.</p>
        <Login />
      </div>
      <p className="stage">STAGING / SYNTHETIC / SHADOW / NO LIVE BILLING</p>
    </main>
  );
}
