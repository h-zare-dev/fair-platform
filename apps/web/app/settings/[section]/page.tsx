import { notFound, redirect } from 'next/navigation';
import { ownerSession } from '../../../lib/session';
import { CatalogManagement } from '../../../components/catalog';
import { OwnerHeader } from '../../../components/owner-header';

export const dynamic = 'force-dynamic';

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (section !== 'packages' && section !== 'groups') notFound();
  const session = await ownerSession();
  if (session === 'anonymous') redirect('/login');
  if (session === 'unavailable')
    return (
      <main className="login-shell">
        <h1>تنظیمات در دسترس نیست</h1>
        <p role="alert">نشست شما قابل تأیید نیست. لطفاً دوباره تلاش کنید.</p>
        <a href="/settings/packages">تلاش دوباره</a>
      </main>
    );
  return (
    <>
      <OwnerHeader active="settings" />
      <main className="dashboard settings-main">
        <CatalogManagement section={section} />
      </main>
    </>
  );
}
