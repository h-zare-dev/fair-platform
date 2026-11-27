import { redirect } from 'next/navigation';
import { ownerSession } from '../../lib/session';
import { Login } from '../../components/login';
import { ThemeToggle } from '../../components/theme-toggle';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  if ((await ownerSession()) === 'authenticated') redirect('/dashboard');
  return (
    <main className="login-shell">
      <div className="login-topbar">
        <div className="wordmark">
          <span className="brand-mark" aria-hidden="true">
            ف
          </span>
          <span className="brand-text">
            فِیر پلتفرم<small>پنل مدیریت</small>
          </span>
        </div>
        <ThemeToggle />
      </div>
      <div className="login-card">
        <span className="login-symbol" aria-hidden="true">
          ✦
        </span>
        <p className="eyebrow">ورود امن مدیر اصلی</p>
        <h1>خوش برگشتید!</h1>
        <p className="muted">برای مشاهدهٔ داشبورد آزمایشی وارد حساب خود شوید.</p>
        <Login />
      </div>
      <p className="stage">
        <span className="stage-dot" aria-hidden="true" /> محیط آزمایشی · بدون
        عملیات مالی زنده
      </p>
    </main>
  );
}
