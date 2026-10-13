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
        <h1>Operations unavailable</h1>
        <p role="alert">
          The service could not verify your session. Please try again.
        </p>
        <a href="/dashboard">Try again</a>
      </main>
    );
  return <Dashboard />;
}
