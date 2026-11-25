import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:tls';
import { test, expect } from '@playwright/test';
const docker = promisify(execFile);
// Chromium debounces Linux interface notifications for 2s. Disposable Docker
// network creation/restarts must settle before navigation; never retry app errors.
const settleLocalNetwork = () =>
  new Promise((resolve) => setTimeout(resolve, 2500));
// Only the disposable loopback Caddy's internal test CA is untrusted.
function certificate(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: '127.0.0.1',
        port: 443,
        servername: 'panel.fairisfair.ir',
        rejectUnauthorized: false,
      },
      () => {
        resolve(socket.getPeerCertificate().fingerprint256);
        socket.end();
      },
    );
    socket.setTimeout(5000, () =>
      socket.destroy(new Error('LOCAL_TLS_TIMEOUT')),
    );
    socket.on('error', reject);
  });
}
test.beforeEach(async ({ context, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const db = createOwnerDataSource(process.env.UI_DATABASE_URL!);
  await db.initialize();
  try {
    await db.query('TRUNCATE fair_owner_login_budget');
  } finally {
    await db.destroy();
  }
  page.on('requestfailed', (r) =>
    console.info(
      'LOCAL_REQUEST_FAILED',
      new URL(r.url()).pathname,
      r.failure()?.errorText,
    ),
  );
  await settleLocalNetwork();
  // Intercept every browser request; never contact real public DNS or staging.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://panel.fairisfair.ir') {
      await route.abort();
      return;
    }
    await route.continue();
  });
});
test('protected login, synthetic dashboard, filters and logout on desktop/mobile', async ({
  page,
  context,
}) => {
  const packageName = `آزمایش نیم گیگ ${test.info().project.name}`;
  const groupName = `گروه آزمایشی ${test.info().project.name}`;
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole('heading', { name: 'خوش برگشتید!' }),
  ).toBeVisible();
  await expect(
    page.getByText('محیط آزمایشی · بدون عملیات مالی زنده'),
  ).toBeVisible();
  await page
    .getByLabel('گذرواژهٔ مدیر اصلی')
    .fill('synthetic-browser-test-password');
  const submitted = page.waitForResponse((r) =>
    r.url().endsWith('/api/v1/owner/auth/login'),
  );
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  const response = await submitted;
  expect(
    response.status(),
    `origin=${response.request().headers()['origin'] ?? 'absent'}`,
  ).toBe(201);

  await expect(
    page.getByRole('heading', { name: /سلام، خوش آمدید/ }),
  ).toBeVisible();
  await expect(
    page.locator('.stage[data-staging-billing-mode="no-live-billing"]'),
  ).toBeVisible();
  await expect(page.getByText('در حال دریافت اطلاعات…')).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'تاریخچهٔ رویدادهای اخیر' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'تست ترکیبی FP-006 / FP-007: Update و Reset',
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'تست دفتر حسابداری آرشیو ۳۰روزه' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'گزارش‌ها', exact: true }),
  ).toHaveAttribute('href', '/reports');
  await expect(page.locator('.quick-nav a')).toHaveCount(4);
  await expect(
    page.getByRole('link', { name: 'ابهامات ثبت شبانه' }),
  ).toHaveAttribute('href', '/accounting/ambiguities');
  await expect(
    page.getByRole('navigation', { name: 'بخش‌های پنل' }).getByRole('link', {
      name: 'تنظیمات پکیج‌ها',
    }),
  ).toHaveCount(0);
  await expect(page.locator('.kpi .number').first()).toHaveText('۱۲');
  await expect(page.locator('.kpi .number').nth(1)).toHaveText('۱۱');
  await expect(page.getByText('۱۰ گیگابایت').first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'پکیج‌های قیمت‌گذاری' }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'تنظیمات', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/packages$/);
  await expect(
    page.getByRole('heading', { name: 'پکیج‌های قیمت‌گذاری' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '+ پکیج جدید' }).click();
  const packageDialog = page.getByRole('dialog');
  await packageDialog.getByLabel('نام پکیج').fill(packageName);
  await packageDialog.getByLabel('حجم (گیگابایت)').fill('۰٫۵');
  await packageDialog.getByLabel('مدت (روز)').fill('۳۰');
  await packageDialog.getByLabel('قیمت پکیج (تومان)').fill('۱۵۰۰۰۰');
  await packageDialog.getByRole('button', { name: 'ذخیرهٔ پکیج' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.catalog-toast')).toContainText('عملیات موفق');
  await expect(page.locator('.catalog-toast-progress')).toBeVisible();
  await expect(page.getByRole('heading', { name: packageName })).toBeVisible();
  await page
    .locator('.catalog-tile')
    .filter({ has: page.getByRole('heading', { name: packageName }) })
    .getByRole('button', { name: 'کپی پکیج' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('کپی پکیج');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'بستن پنجره' })
    .click();
  await page
    .getByRole('link', { name: /گروه‌ها/ })
    .last()
    .click();
  await expect(page).toHaveURL(/\/settings\/groups$/);
  await page.getByRole('button', { name: '+ گروه جدید' }).click();
  await page.getByRole('dialog').getByLabel('نام گروه').fill(groupName);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'ایجاد گروه' })
    .click();
  await expect(page.getByRole('heading', { name: groupName })).toBeVisible();
  await page.route('**/api/v1/owner/directory/admins?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'available',
        admins: [{ id: '9001', username: 'synthetic_manager' }],
        total: 1,
        offset: 0,
        limit: 25,
      }),
    }),
  );
  await page
    .locator('.catalog-tile')
    .filter({ has: page.getByRole('heading', { name: groupName }) })
    .getByRole('button', { name: 'مدیران گروه' })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    'جست‌وجو در فهرست مدیران پاسارگاد',
  );
  await expect(page.getByRole('dialog').getByLabel(/ورود دستی/)).toHaveCount(0);
  await expect(
    page.getByRole('dialog').getByRole('button', { name: /synthetic_manager/ }),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /synthetic_manager/ })
    .click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText(
    'synthetic_manager',
  );
  await expect(page.getByRole('dialog').getByRole('status')).toContainText(
    '9001',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'بستن پنجره' })
    .click();
  await page.unroute('**/api/v1/owner/directory/admins?*');
  await page.route('**/api/v1/owner/directory/admins?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"message":"DIRECTORY_UNAVAILABLE"}',
    }),
  );
  await page
    .locator('.catalog-tile')
    .filter({ has: page.getByRole('heading', { name: groupName }) })
    .getByRole('button', { name: 'مدیران گروه' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('DIRECTORY_UNAVAILABLE');
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: '+ افزودن مدیر به گروه' }),
  ).toBeDisabled();
  await expect(page.getByRole('dialog').getByLabel(/ورود دستی/)).toHaveCount(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'بستن پنجره' })
    .click();
  await page.getByRole('link', { name: 'داشبورد', exact: true }).click();
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-fair_owner');
  expect(session).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.getByRole('button', { name: 'فعال‌کردن تم تاریک' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(
    await page.evaluate(() => localStorage.getItem('fair-owner-theme')),
  ).toBe('dark');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const cert = await certificate();
  await docker('docker', [
    'restart',
    '--time',
    '2',
    process.env.UI_API_CONTAINER!,
  ]);
  await expect
    .poll(
      async () =>
        (
          await docker('docker', [
            'inspect',
            '--format',
            '{{.State.Health.Status}}',
            process.env.UI_API_CONTAINER!,
          ])
        ).stdout.trim(),
      { timeout: 20000 },
    )
    .toBe('healthy');
  await docker('docker', [
    'restart',
    '--time',
    '2',
    process.env.UI_CADDY_CONTAINER!,
  ]);
  await expect
    .poll(
      async () => {
        try {
          return await certificate();
        } catch {
          return '';
        }
      },
      { timeout: 10000 },
    )
    .toBe(cert);
  await settleLocalNetwork();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: /سلام، خوش آمدید/ }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.kpi .number').first()).toHaveText('۱۲');
  await expect(page.locator('.inbox-progress')).toContainText(
    'دسته‌های پردازش‌شده:',
  );
  await expect(page.locator('.inbox-progress progress')).toHaveAttribute(
    'max',
    '100',
  );
  await expect(page.locator('.range')).toContainText(
    'رویدادهای تازه پردازش‌شده در ۲۴ ساعت اخیر',
  );
  await page.getByLabel('بازهٔ زمانی').selectOption('1h');
  await expect(page.locator('.kpi .number').first()).toHaveText('۱۲');
  await page
    .getByLabel('شناسهٔ منبع', { exact: true })
    .fill('missing-synthetic-source');
  await page.getByRole('button', { name: 'اعمال فیلتر' }).click();
  await expect(
    page.getByText('در این بازه زمانی داده‌ای ثبت نشده است.'),
  ).toHaveCount(2);
  await expect(page.locator('.kpi .number').first()).toHaveText('۰');
  await page.getByRole('button', { name: 'خروج از حساب' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
test('selected historical source survives dashboard to packages and groups navigation', async ({
  page,
}) => {
  await page.goto('/login');
  await page
    .getByLabel('گذرواژهٔ مدیر اصلی')
    .fill('synthetic-browser-test-password');
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByLabel('بازهٔ زمانی').selectOption('replay-fixed');
  await expect(page.getByLabel('شناسهٔ منبع', { exact: true })).toHaveValue(
    'replay-30d',
  );
  await page.getByRole('link', { name: 'تنظیمات', exact: true }).click();
  await expect(page.getByTestId('active-catalog-dataset')).toContainText(
    'آرشیو تاریخی ۳۰روزه',
  );
  await page.locator('a[href="/settings/groups"]').click();
  await expect(page.getByTestId('active-catalog-dataset')).toContainText(
    'آرشیو تاریخی ۳۰روزه',
  );
  await page.goto('/dashboard');
  await expect(page.getByLabel('بازهٔ زمانی')).toHaveValue('replay-fixed');
});
test('obsolete historical previews are gone while SHADOW and bootstrap tools remain accessible', async ({
  page,
}) => {
  await page.goto('/login');
  await page
    .getByLabel('گذرواژهٔ مدیر اصلی')
    .fill('synthetic-browser-test-password');
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('button', { name: 'اجرای بررسی آزمایشی ۳۰روزه' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'اجرای بررسی ترکیبی Update و Reset' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'تست دفتر حسابداری آرشیو ۳۰روزه' }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'گزارش‌ها', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(
    page.getByRole('heading', { name: 'گزارش‌های جامع حسابداری' }),
  ).toBeVisible();
  const advanced = page.getByText(
    'ابزار پیشرفته: اجرای مجدد آزمون آفلاین SHADOW',
  );
  await expect(advanced).toBeVisible();
  await advanced.click();
  await expect(
    page.getByRole('heading', { name: 'تست دفتر حسابداری آرشیو ۳۰روزه' }),
  ).toBeVisible();
  await expect(
    page.getByText('فقط SHADOW · بدون تغییر موجودی واقعی'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'تنظیمات', exact: true }).click();
  await page.locator('a[href="/settings/initialization"]').click();
  await expect(page).toHaveURL(/\/settings\/initialization$/);
  await expect(
    page.getByRole('heading', { name: 'راه‌اندازی اولیه' }),
  ).toBeVisible();
  await expect(
    page.getByText('ابزار راه‌اندازی یک‌بارهٔ پکیج‌ها (در صورت نیاز)'),
  ).toBeVisible();
});
test('wrong password and failed operations show safe errors, never zero substitutes', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('گذرواژهٔ مدیر اصلی').fill('synthetic-wrong');
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'ورود انجام نشد',
  );
  await page
    .getByLabel('گذرواژهٔ مدیر اصلی')
    .fill('synthetic-browser-test-password');
  const submitted = page.waitForResponse((r) =>
    r.url().endsWith('/api/v1/owner/auth/login'),
  );
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  const response = await submitted;
  expect(
    response.status(),
    `origin=${response.request().headers()['origin'] ?? 'absent'}`,
  ).toBe(201);

  await expect(
    page.getByRole('heading', { name: /سلام، خوش آمدید/ }),
  ).toBeVisible();
  await page.route('**/api/v1/owner/operations/summary?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"message":"Request failed"}',
    }),
  );
  await expect(page.getByRole('button', { name: 'به‌روزرسانی' })).toBeEnabled();
  await page.getByRole('button', { name: 'به‌روزرسانی' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'تعدادها قابل نمایش نیستند',
  );
  await expect(page.locator('.kpi .number').first()).toHaveText('—');
});

test('server-rendered login cannot submit a password through a GET URL before hydration', async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ignoreHTTPSErrors: true,
  });
  try {
    await context.route('**/*', async (route) => {
      if (
        new URL(route.request().url()).origin !== 'https://panel.fairisfair.ir'
      )
        await route.abort();
      else await route.continue();
    });
    const page = await context.newPage();
    await page.goto('https://panel.fairisfair.ir/login');
    await expect(page.getByLabel('گذرواژهٔ مدیر اصلی')).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'آماده‌سازی ورود…' }),
    ).toBeDisabled();
    await expect(page.locator('form')).toHaveAttribute('method', 'post');
    await expect(
      page.getByText('برای ورود امن باید جاوااسکریپت فعال باشد.'),
    ).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  } finally {
    await context.close();
  }
});

test('switching report tabs never renders stale administrator rows as event evidence', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  let calendarMode: 'jalali' | 'gregorian' = 'jalali';
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/login');
  await page
    .getByLabel('گذرواژهٔ مدیر اصلی')
    .fill('synthetic-browser-test-password');
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.route(/\/audit\/overview(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        mode: 'HISTORICAL_SHADOW_AUDIT',
        postingScope: 'SHADOW',
        liveBalanceMutated: false,
        reportCalendar: calendarMode,
        run: {
          id: '1',
          eventCount: 1,
          entryCount: 0,
          heldCount: 0,
          deleteCreditEnabled: false,
        },
        runs: [
          { id: '1', status: 'COMPLETE', createdAt: '2026-01-01T00:00:00Z' },
        ],
        coverage: {
          from: '1405-05-01',
          to: '1405-08-30',
          verifiedBoundaries: true,
        },
        timeZone: 'Asia/Tehran',
        weekStartDay: 'SATURDAY',
        totals: {
          chargesToman: '0',
          creditsToman: '0',
          netToman: '0',
          heldCandidates: 0,
          pendingDays: 0,
          ignoredEvents: 1,
        },
        integrity: { status: 'RECONCILED', errors: [] },
        historicalSourceIdentity: {
          status: 'NOT_IMPORTED',
          mappedBillingAdmins: 0,
          mappedAccounts: 0,
          mappedActorAdmins: 0,
          unmatchedArchiveAdminPairs: null,
          unmatchedArchiveAccountPairs: null,
        },
      },
    }),
  );
  await page.route(/\/audit\/admins(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        runId: '1',
        nextOffset: null,
        rows: [
          {
            billingAdminId: '1',
            adminName: 'Test admin',
            nameStatus: 'SOURCE_VERIFIED_HISTORICAL',
            names: ['Test admin'],
            observedDays: '1',
            readyDays: '1',
            pendingDays: '0',
            chargeToman: '0',
            creditToman: '0',
            netToman: '0',
            holdCount: '0',
            heldCandidateCount: 0,
            entryCount: '0',
          },
        ],
      },
    }),
  );
  await page.route(/\/audit\/holds(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { runId: '1', nextOffset: null, rows: [] },
    }),
  );
  const periodRequests: URL[] = [];
  await page.route(/\/audit\/periods(?:\?.*)?$/, (route) => {
    periodRequests.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        runId: '1',
        billingAdminId: null,
        nextOffset: null,
        rows: [
          {
            startDate: calendarMode === 'jalali' ? '1405-08-01' : '2026-11-01',
            endDate: calendarMode === 'jalali' ? '1405-08-30' : '2026-11-30',
            status: 'RECONCILED',
            observedDays: 2,
            readyDays: 2,
            pendingDays: 0,
            entryCount: 2,
            holdCount: 0,
            readyChargeToman: '200000',
            readyCreditToman: '0',
            readyNetToman: '200000',
            readyChargeBytes: '214748364800',
            chargeBytes: '214748364800',
            chargeToman: '200000',
            creditToman: '0',
            netToman: '200000',
          },
        ],
      },
    });
  });
  await page.goto('/reports');
  const adminRow = page.getByRole('row').filter({ hasText: 'Test admin' });
  await expect(adminRow).toBeVisible();
  await page.getByRole('button', { name: 'ابهامات', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'علت بررسی' }),
  ).toBeVisible();
  await expect(adminRow).toHaveCount(0);
  await page.getByRole('button', { name: 'ماهانه', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'جمع حجم ثبت‌شده' }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /۲۰۰ گیگابایت/ })).toBeVisible();
  expect(periodRequests.at(-1)?.searchParams.get('billingAdminId')).toBeNull();
  const picker = page.locator('.report-date-trigger');
  await picker.click();
  const dialog = page.getByRole('dialog', { name: 'انتخاب بازهٔ تاریخ گزارش' });
  await dialog.locator('.report-date-grid button').first().click();
  // Mobile popovers are fixed overlays covering the underlying report panel.
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  expect(periodRequests.at(-1)?.searchParams.get('from')).toBeNull();

  await picker.click();
  await dialog.getByRole('button', { name: /تا تاریخ/ }).focus();
  await page.locator('.report-admin-trigger').focus();
  await expect(dialog).toHaveCount(0);

  await picker.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeFocused();

  await picker.click();
  await dialog.locator('.report-date-grid button').first().click();
  await dialog.locator('.report-date-grid button').last().click();
  await dialog.getByRole('button', { name: 'اعمال بازه' }).click();
  await expect
    .poll(() => periodRequests.at(-1)?.searchParams.get('from'))
    .toBe('1405-08-01');
  await expect
    .poll(() => periodRequests.at(-1)?.searchParams.get('to'))
    .toBe('1405-08-30');
  await page.locator('.report-admin-trigger').click();
  const adminDialog = page.getByRole('dialog', {
    name: 'فیلتر گزارش بر اساس مدیر',
  });
  await adminDialog.getByRole('searchbox').fill('Test');
  await page.mouse.click(5, 5);
  await expect(adminDialog).toHaveCount(0);
  expect(periodRequests.at(-1)?.searchParams.get('billingAdminId')).toBeNull();

  await page.locator('.report-admin-trigger').click();
  await page.locator('.report-date-trigger').focus();
  await expect(adminDialog).toHaveCount(0);

  await page.locator('.report-admin-trigger').click();
  await page.keyboard.press('Escape');
  await expect(adminDialog).toHaveCount(0);
  await expect(page.locator('.report-admin-trigger')).toBeFocused();

  await page.locator('.report-admin-trigger').click();
  await page
    .getByRole('dialog', { name: 'فیلتر گزارش بر اساس مدیر' })
    .getByRole('button', { name: 'Test admin' })
    .click();
  await expect
    .poll(() => periodRequests.at(-1)?.searchParams.get('billingAdminId'))
    .toBe('1');
  await page.locator('.report-admin-trigger').click();
  await page
    .getByRole('dialog', { name: 'فیلتر گزارش بر اساس مدیر' })
    .getByRole('button', { name: 'همهٔ مدیران' })
    .click();
  await expect
    .poll(() => periodRequests.at(-1)?.searchParams.get('billingAdminId'))
    .toBeNull();

  calendarMode = 'gregorian';
  await page.reload();
  await page.getByRole('button', { name: 'ماهانه', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'بازهٔ میلادی' }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /نوامبر ۲۰۲۶/ })).toBeVisible();
  await picker.click();
  await expect(dialog.getByRole('combobox', { name: 'ماه تقویم' })).toHaveValue(
    '11',
  );
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
