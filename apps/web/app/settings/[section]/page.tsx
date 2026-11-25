import { notFound, redirect } from 'next/navigation';
import { ownerSession } from '../../../lib/session';
import { CatalogManagement } from '../../../components/catalog';
import { OwnerHeader } from '../../../components/owner-header';
import { OpeningBaseline } from '../../../components/opening-baseline';
import { CatalogBootstrap } from '../../../components/catalog-bootstrap';
import { ChangePassword } from '../../../components/change-password';

export const dynamic = 'force-dynamic';

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (
    section !== 'packages' &&
    section !== 'groups' &&
    section !== 'initialization' &&
    section !== 'security'
  )
    notFound();
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
        {section === 'security' ? (
          <>
            <div className="settings-heading">
              <div>
                <p className="eyebrow">پنل مدیریت / تنظیمات</p>
                <h1>امنیت حساب</h1>
              </div>
            </div>
            <nav className="settings-nav" aria-label="بخش‌های تنظیمات">
              <a href="/settings/packages">
                <b>پکیج‌ها</b>
              </a>
              <a href="/settings/groups">
                <b>گروه‌ها</b>
              </a>
              <a href="/settings/initialization">
                <b>راه‌اندازی اولیه</b>
              </a>
              <a href="/settings/security" aria-current="page">
                <b>امنیت حساب</b>
              </a>
            </nav>
            <ChangePassword />
          </>
        ) : section === 'initialization' ? (
          <section
            className="settings-catalog"
            aria-label="راه‌اندازی اولیه حسابداری"
          >
            <div className="stage" data-staging-billing-mode="no-live-billing">
              محیط آزمایشی · بدون تغییر موجودی واقعی
            </div>
            <div className="settings-heading">
              <div>
                <p className="eyebrow">پنل مدیریت / تنظیمات</p>
                <h1>راه‌اندازی اولیه</h1>
                <p className="muted">
                  دریافت و بازنشانی وضعیت اولیهٔ اکانت‌ها، بدون اتصال وب‌هوک و
                  بدون ثبت مالی.
                </p>
              </div>
            </div>
            <nav className="settings-nav" aria-label="بخش‌های تنظیمات">
              <a href="/settings/packages">
                <b>پکیج‌ها</b>
                <small>قیمت و مدت پکیج</small>
              </a>
              <a href="/settings/groups">
                <b>گروه‌ها</b>
                <small>اعضا و اختصاص پکیج</small>
              </a>
              <a href="/settings/initialization" aria-current="page">
                <b>راه‌اندازی اولیه</b>
                <small>دریافت وضعیت اکانت‌ها</small>
              </a>
              <a href="/settings/security">
                <b>امنیت حساب</b>
                <small>تغییر رمز عبور</small>
              </a>
            </nav>
            <OpeningBaseline />
            <details className="catalog-source-panel">
              <summary>ابزار راه‌اندازی یک‌بارهٔ پکیج‌ها (در صورت نیاز)</summary>
              <p className="muted">
                اگر پکیج‌ها و گروه‌ها از قبل ثبت شده‌اند، نیازی به اجرای مجدد
                این ابزار نیست. ثبت دوباره روی تنظیمات موجود مسدود است.
              </p>
              <CatalogBootstrap />
            </details>
          </section>
        ) : (
          <CatalogManagement section={section} />
        )}
      </main>
    </>
  );
}
