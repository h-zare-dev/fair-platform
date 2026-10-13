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
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole('heading', { name: 'Welcome back.' }),
  ).toBeVisible();
  await expect(
    page.getByText('STAGING / SYNTHETIC / SHADOW / NO LIVE BILLING'),
  ).toBeVisible();
  await page
    .getByLabel('Owner password')
    .fill('synthetic-browser-test-password');
  const submitted = page.waitForResponse((r) =>
    r.url().endsWith('/api/v1/owner/auth/login'),
  );
  await page.getByRole('button', { name: 'Sign in →' }).click();
  const response = await submitted;
  expect(
    response.status(),
    `origin=${response.request().headers()['origin'] ?? 'absent'}`,
  ).toBe(201);

  await expect(
    page.getByRole('heading', { name: 'Operations', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Loading operations…')).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Recent normalized events' }),
  ).toBeVisible();
  await expect(page.locator('.kpi .number').first()).toHaveText('12');
  await expect(page.locator('.kpi .number').nth(1)).toHaveText('11');
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-fair_owner');
  expect(session).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
  });
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
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
    page.getByRole('heading', { name: 'Operations', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.kpi .number').first()).toHaveText('12');
  await page.getByLabel('Time range').selectOption('1h');
  await expect(page.locator('.kpi .number').first()).toHaveText('12');
  await page.getByLabel('Source instance').fill('missing-synthetic-source');
  await page.getByRole('button', { name: 'Apply source' }).click();
  await expect(page.getByText('No records in this range.')).toHaveCount(2);
  await expect(page.locator('.kpi .number').first()).toHaveText('0');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
test('wrong password and failed operations show safe errors, never zero substitutes', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Owner password').fill('synthetic-wrong');
  await page.getByRole('button', { name: 'Sign in →' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Unable to sign in',
  );
  await page
    .getByLabel('Owner password')
    .fill('synthetic-browser-test-password');
  const submitted = page.waitForResponse((r) =>
    r.url().endsWith('/api/v1/owner/auth/login'),
  );
  await page.getByRole('button', { name: 'Sign in →' }).click();
  const response = await submitted;
  expect(
    response.status(),
    `origin=${response.request().headers()['origin'] ?? 'absent'}`,
  ).toBe(201);

  await expect(
    page.getByRole('heading', { name: 'Operations', exact: true }),
  ).toBeVisible();
  await page.route('**/api/v1/owner/operations/summary?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"message":"Request failed"}',
    }),
  );
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Counts could not be loaded',
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
    await expect(page.getByLabel('Owner password')).toBeDisabled();
    await expect(page.getByRole('button')).toBeDisabled();
    await expect(page.locator('form')).toHaveAttribute('method', 'post');
    await expect(
      page.getByText('JavaScript is required for secure sign in.'),
    ).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
  } finally {
    await context.close();
  }
});
