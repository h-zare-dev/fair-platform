import { redirect } from 'next/navigation';
import { ownerSession } from '../../lib/session';
import { OwnerHeader } from '../../components/owner-header';
import { ShadowAuditReports } from '../../components/shadow-audit-reports';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const session = await ownerSession();
  if (session === 'anonymous') redirect('/login');
  if (session === 'unavailable')
    return (
      <main className="login-shell">
        <h1>پنل گزارش‌ها در دسترس نیست</h1>
        <p role="alert">نشست شما قابل تأیید نیست. لطفاً دوباره تلاش کنید.</p>
        <a href="/reports">تلاش دوباره</a>
      </main>
    );
  return (
    <>
      <OwnerHeader active="reports" />
      <main className="dashboard audit-reports-main" dir="rtl">
        <header className="dashboard-intro">
          <p className="eyebrow">پنل مدیریت / گزارش‌ها / ممیزی دفتر آزمایشی</p>
          <h1>گزارش‌های جامع حسابداری</h1>
          <p className="muted">
            ریزعملیات هر مدیر در دوره‌های روزانه، هفتگی و ماهانه، همراه با
            ابهامات و شواهد منبع.
          </p>
        </header>
        <ShadowAuditReports />
      </main>
    </>
  );
}
