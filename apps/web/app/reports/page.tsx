import { redirect } from 'next/navigation';
import { ownerSession } from '../../lib/session';
import { OwnerHeader } from '../../components/owner-header';
import { ShadowAuditReports } from '../../components/shadow-audit-reports';
import { ReplayShadowJournal } from '../../components/replay-shadow-journal';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
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
  const { view } = await searchParams;
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
        <details className="catalog-source-panel">
          <summary>ابزار پیشرفته: اجرای مجدد آزمون آفلاین SHADOW</summary>
          <p className="muted">
            فقط برای بررسی مجدد آرشیو و تنظیمات آزمایشی؛ اجرای جدید، مبالغ
            اجراهای قبلی یا موجودی واقعی را تغییر نمی‌دهد.
          </p>
          <ReplayShadowJournal />
        </details>
        <ShadowAuditReports
          initialView={view === 'holds' ? 'holds' : 'admins'}
        />
      </main>
    </>
  );
}
