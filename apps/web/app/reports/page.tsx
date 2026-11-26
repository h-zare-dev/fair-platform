import { redirect } from 'next/navigation';
import { ownerSession } from '../../lib/session';
import { AccountingAmbiguities } from '../../components/accounting-ambiguities';

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
  return <AccountingAmbiguities reports />;
}
