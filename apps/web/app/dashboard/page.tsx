import { redirect } from 'next/navigation';
import { ownerSession } from '../../lib/session';
import { Dashboard } from '../../components/dashboard';
export const dynamic = 'force-dynamic';
export default async function DashboardPage() {
  const session = await ownerSession();
  if (session === 'anonymous') redirect('/login');
  if (session === 'unavailable')
    return (
      <main className="login-shell">
        <h1>پنل مدیریت در دسترس نیست</h1>
        <p role="alert">نشست شما قابل تأیید نیست. لطفاً دوباره تلاش کنید.</p>
        <a href="/dashboard">تلاش دوباره</a>
      </main>
    );
  return <Dashboard />;
}
