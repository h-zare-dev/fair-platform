import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  operationFilter,
  nextCursor,
} from '../../apps/api/dist/owner/application/operations.js';
const read = (p: string) => readFileSync(p, 'utf8');
it('release failure/recovery state machine passes its adversarial suite', () => {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'tests/release'],
    { encoding: 'utf8' },
  );
  expect(result.stderr, result.stdout).not.toContain('FAILED');
  expect(result.status, result.stderr).toBe(0);
});
it('CI publishes scanned images but never deploys to the retired staging host', () => {
  const ci = read('.github/workflows/ci.yml');
  expect(ci).not.toContain('pull_request_target');
  expect(ci).not.toContain('self-hosted');
  expect(ci.match(/packages: write/g)).toHaveLength(1);
  expect(ci).toContain('github.ref_protected');
  expect(ci).toContain('  publish:');
  expect(ci).toContain('needs: [quality, security, containers, owner-merge]');
  expect(ci).toContain('needs: [image-release, owner-merge]');
  expect(ci).toContain('docker push "$image"');
  const preMerge = ci.split('\n  owner-merge:')[0]!;
  expect(preMerge).not.toContain('docker/build-push-action@');
  expect(preMerge).not.toContain('image-ref:');
  expect(ci).toContain("needs.owner-merge.outputs.authorized == 'true'");
  expect(ci).not.toContain('\n  deploy:');
  expect(ci).not.toContain('secrets.STAGING_BOOTSTRAP_');
  expect(ci).not.toContain('bash scripts/staging/ci-post-merge-local.sh');
  for (const match of ci.matchAll(/uses: ([^\s]+)/g))
    expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
});

it('staging publishes only Caddy TCP443, persists data and retains webhook guard', () => {
  const compose = read('docker/staging/compose.yml');
  expect(compose.match(/ports:/g)).toHaveLength(1);
  expect(compose).toContain('443:443/tcp');
  expect(compose).not.toContain('443/udp');
  expect(compose).not.toContain('network_mode: host');
  expect(compose).not.toContain('docker.sock');
  expect(compose).toContain('postgres_data:/var/lib/postgresql/data');
  expect(compose).toContain('caddy_data:/data');
  const caddy = read('docker/staging/Caddyfile');
  expect(caddy).toContain('auto_https disable_redirects');
  expect(caddy).toContain('disable_http_challenge');
  expect(caddy).toContain('protocols h1 h2');
  expect(read('apps/api/src/main.ts')).toContain(
    'VERIFIED_WEBHOOK_AUTHENTICATOR_REQUIRED',
  );
  expect(read('apps/api/src/owner/app.ts')).toContain(
    'ShadowWebhookController',
  );
  expect(read('apps/api/src/owner/app.ts')).toContain('if (!webhook)');
  expect(compose).toContain('PASARGUARD_WEBHOOK_SECRET_FILE');
  expect(caddy).toContain('max_size 256KB');
});
it('staging smoke checks a stable no-live-billing marker, not translated dashboard text', () => {
  const dashboard = read('apps/web/components/dashboard.tsx');
  const smoke = read('apps/api/src/owner/smoke.ts');
  const marker = 'data-staging-billing-mode="no-live-billing"';
  expect(dashboard).toContain(marker);
  expect(dashboard).toContain('بدون دریافت وجه واقعی');
  expect(smoke).toContain(`.includes(\n          '${marker}',`);
  expect(smoke).not.toContain("includes('NO LIVE BILLING')");
});
it('cursor validation rejects overflow, reuse, out-of-window values and submicrosecond input', () => {
  const query = {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-02T00:00:00Z',
    source: 'synthetic-fp003b',
  };
  const f = operationFilter(query, 'events');
  const cursor = nextCursor(f, 'events', '2026-10-01T00:00:00.000001Z', '1');
  expect(operationFilter({ ...query, cursor }, 'events').cursor?.id).toBe('1');
  for (const q of [
    { ...query, cursor, source: 'other' },
    {
      ...query,
      cursor: nextCursor(
        f,
        'events',
        '2026-10-01T00:00:00Z',
        '9223372036854775808',
      ),
    },
    { ...query, cursor: nextCursor(f, 'events', '2026-10-02T00:00:00Z', '1') },
    { ...query, start: '2026-10-01T00:00:00.0000001Z' },
  ])
    expect(() => operationFilter(q, 'events')).toThrow();
  expect(() => operationFilter({ ...query, cursor }, 'issues')).toThrow();
});

it('rejects ISO year zero before querying PostgreSQL', () => {
  expect(() =>
    operationFilter(
      { start: '0000-01-01T00:00:00Z', end: '0000-01-02T00:00:00Z' },
      'events',
    ),
  ).toThrow();
});
