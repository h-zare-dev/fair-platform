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
it('CI deploy is gated, PR-safe and pinned; only publish receives package write', () => {
  const ci = read('.github/workflows/ci.yml');
  expect(ci).not.toContain('pull_request_target');
  expect(ci).not.toContain('self-hosted');
  expect(ci.match(/packages: write/g)).toHaveLength(1);
  expect(ci).toContain("vars.FP003B_STAGING_ACTIVATED == 'owner-approved-v1'");
  expect(ci).toContain('github.ref_protected');
  const deploy = ci.split('  deploy:')[1]!;
  expect(deploy).toContain("github.event_name == 'push'");
  expect(deploy).toContain("github.ref == 'refs/heads/development'");
  expect(deploy).toContain('environment: staging');
  expect(deploy).toContain('cancel-in-progress: false');
  expect(ci.split('  deploy:')[0]).not.toContain('secrets.STAGING_');
  for (const match of ci.matchAll(/uses: ([^\s]+)/g))
    expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
  const ssh = read('scripts/staging/ci-ssh.sh');
  expect(ssh).toContain('StrictHostKeyChecking=yes');
  expect(ssh).toContain('UserKnownHostsFile=');
  expect(ssh).not.toContain('ssh-keyscan');
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
  expect(read('apps/api/src/owner/app.ts')).not.toContain('WebhookController');
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
