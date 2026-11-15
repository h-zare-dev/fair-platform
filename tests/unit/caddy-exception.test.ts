import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const policyPath =
  '.github/security/caddy-go-jose-v3-temporary-exception.yaml';
const policy = readFileSync(policyPath, 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('Caddy temporary security exception', () => {
  it('targets only the known unpatched v3 package and expires in 30 days', () => {
    expect(policy.match(/\bid: CVE-/g)).toHaveLength(1);
    expect(policy).toContain('id: CVE-2026-116587');
    expect(policy.match(/pkg:golang\//g)).toHaveLength(1);
    expect(policy).toContain(
      'pkg:golang/github.com/go-jose/go-jose/v3@v3.0.5',
    );
    expect(policy).toContain('expired_at: 2026-12-15');
    expect(policy).not.toMatch(/not_affected/);
  });

  it('loads the exception in source and Caddy scans only', () => {
    const sections = ci.split(/^      - name: /m);
    const usesException = sections.filter((section) =>
      section.includes(`trivyignores: ${policyPath}`),
    );
    expect(usesException).toHaveLength(2);
    expect(
      usesException.map((section) => section.split('\n')[0]).sort(),
    ).toEqual([
      'Dependency and secret scan',
      'Scan Caddy',
    ]);
    for (const section of usesException) {
      expect(section).toContain("exit-code: '1'");
      expect(section).toContain('severity: HIGH,CRITICAL');
    }
    for (const name of [
      'Scan API image',
      'Scan Web image',
      'Scan PostgreSQL',
    ]) {
      const section = sections.find((part) => part.startsWith(name));
      expect(section).toBeDefined();
      expect(section).not.toContain('trivyignores:');
    }
  });
});
