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
  const summaryRoute = '**/operations/summary?**';
  let releaseRefresh!: () => void;
  const pausedRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let markIntercepted!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    markIntercepted = resolve;
  });
  await page.route(summaryRoute, async (route) => {
    markIntercepted();
    await pausedRefresh;
    await route.continue();
  });
  const refreshed = page.waitForResponse(summaryRoute);
  await page.getByRole('button', { name: /به‌روزرسانی/ }).click();
  await intercepted;
  try {
    await expect(page.locator('.kpis')).toHaveAttribute('aria-busy', 'false');
    await expect(
      page.getByRole('heading', { name: 'تاریخچهٔ رویدادهای اخیر' }),
    ).toBeVisible();
  } finally {
    releaseRefresh();
    await refreshed;
    await page.unroute(summaryRoute);
  }
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
  await expect(page.locator('.kpi .number').first()).toHaveText('۰');
  await expect(page.locator('.kpi .number').nth(1)).toHaveText('۰');
  await expect(
    page.getByText('در این بازه زمانی داده‌ای ثبت نشده است.'),
  ).toHaveCount(2);
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
  await page.route('**/api/v1/owner/directory/admins?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    const admins = Array.from({ length: 150 }, (_, i) => ({
      id: String(9001 + i),
      username: i === 0 ? 'synthetic_manager' : `fixture_${i}`,
    }));
    return route.fulfill({
      json: {
        status: 'available',
        admins: admins.slice(offset, offset + limit),
        total: admins.length,
        offset,
        limit,
      },
    });
  });
  await page
    .locator('.catalog-tile')
    .filter({ has: page.getByRole('heading', { name: groupName }) })
    .getByRole('button', { name: 'مدیران گروه' })
    .click();
  const available = page.getByRole('region', { name: 'مدیران قابل افزودن' });
  const members = page.getByRole('region', { name: 'اعضای گروه' });
  await expect(
    available.getByRole('checkbox', { name: /fixture_149/ }),
  ).toBeVisible();
  const selectAll = available.getByRole('checkbox', {
    name: 'انتخاب همهٔ مدیران',
  });
  await selectAll.check();
  await expect(
    available.getByRole('button', { name: /افزودن به گروه.*150/ }),
  ).toBeEnabled();
  await selectAll.uncheck();
  await available.getByRole('checkbox', { name: /fixture_149/ }).check();
  await available.getByRole('button', { name: /افزودن به گروه/ }).click();
  await expect(members.getByText('fixture_149', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'بستن پنجره' }).click();
  await page
    .locator('.catalog-tile')
    .filter({ has: page.getByRole('heading', { name: groupName }) })
    .getByRole('button', { name: 'مدیران گروه' })
    .click();
  await expect(members.getByText('fixture_149', { exact: true })).toBeVisible();
  await expect(
    available.getByRole('checkbox', { name: /fixture_149/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'بستن پنجره' }).click();
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
    page.getByRole('dialog').getByRole('button', { name: /افزودن به گروه/ }),
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
  await expect(page.locator('.kpi .number').first()).toHaveText('۰');
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
  await expect(page.locator('.kpi .number').first()).toHaveText('۰');
  await expect(
    page.getByText('در این بازه زمانی داده‌ای ثبت نشده است.'),
  ).toHaveCount(2);
  await expect(page.locator('.kpi .number').first()).toHaveText('۰');
  await page.getByRole('button', { name: 'خروج از حساب' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
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
  await expect(advanced).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'صورتحساب وبهوک' }),
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

test('saved archive selection cannot change live reports, dashboard or settings', async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('fair-platform.owner.selected-source', 'replay-30d'),
  );
  await page.goto('/login');
  await page
    .getByLabel('گذرواژهٔ مدیر اصلی')
    .fill('synthetic-browser-test-password');
  const summary = page.waitForRequest('**/operations/summary?**');
  await page.getByRole('button', { name: 'ورود به داشبورد ←' }).click();
  expect(new URL((await summary).url()).searchParams.get('source')).toBe(
    'primary',
  );
  await expect(page.locator('option[value="replay-fixed"]')).toHaveCount(0);
  const config = page.waitForRequest('**/catalog/config?**');
  await page.goto('/settings/packages');
  expect(new URL((await config).url()).searchParams.get('source')).toBe(
    'primary',
  );
  await expect(page.getByTestId('active-catalog-dataset')).toHaveCount(0);
  await page.route('**/operations/accounting/reports?**', (route) =>
    route.fulfill({
      json: {
        rows: [
          {
            admin: '12',
            name: 'FastVRay',
            day: '',
            bytes: '10737418240',
            amount: '20000',
            pending: 0,
            detail: null,
            account: null,
          },
        ],
        nextOffset: null,
      },
    }),
  );
  await page.goto('/reports');
  await expect(
    page.getByRole('cell', { name: '۱۰ گیگابایت', exact: true }),
  ).toBeVisible();
  const drill = page.waitForRequest(
    '**/operations/accounting/reports?**view=transactions**',
  );
  await page.getByRole('button', { name: 'FastVRay', exact: true }).click();
  expect(new URL((await drill).url()).searchParams.get('admin')).toBe('12');
  const weekly = page.waitForRequest(
    '**/operations/accounting/reports?**view=week**',
  );
  await page.getByRole('button', { name: 'هفتگی', exact: true }).click();
  expect(new URL((await weekly).url()).searchParams.has('source')).toBe(false);
});
