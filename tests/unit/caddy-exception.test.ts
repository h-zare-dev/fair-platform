import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const exceptionPolicyPath =
  '.github/security/caddy-go-jose-v3-temporary-exception.yaml';
const acceptedPurl = 'pkg:golang/github.com/go-jose/go-jose/v3@v3.0.5';
const policy = readFileSync(exceptionPolicyPath, 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('Caddy temporary security exception', () => {
  it('targets only the known unpatched v3 package and expires', () => {
    const cveCount = policy.match(/\bid: CVE-/g)?.length;
    const purlCount = policy.match(/pkg:golang\//g)?.length;
    expect(cveCount).toBe(1);
    expect(policy).toContain('id: CVE-2026-116587');
    expect(purlCount).toBe(1);
    expect(policy).toContain(acceptedPurl);
    expect(policy).toContain('expired_at: 2026-12-15');
    expect(policy).not.toMatch(/not_affected/);
  });

  it('scopes Caddy image and source exceptions to their own scanners', () => {
    const sections = ci.split(/^      - name: /m);
    const option = 'trivyignores: ' + exceptionPolicyPath;
    const accepted = sections.filter((section) => section.includes(option));
    const names = accepted.map((section) => section.split('\n')[0]).sort();
    expect(names).toEqual(['Scan Caddy']);
    for (const section of accepted) {
      expect(section).toContain("exit-code: '1'");
      expect(section).toContain('severity: HIGH,CRITICAL');
    }
    const sourcePath =
      '.github/security/staging-source-temporary-exceptions.yaml';
    const sourcePolicy = readFileSync(sourcePath, 'utf8');
    expect(sourcePolicy).toContain('id: CVE-2026-116587');
    expect(sourcePolicy).toContain(acceptedPurl);
    expect(sourcePolicy).toContain('id: CVE-2026-112366');
    expect(sourcePolicy).toContain('pkg:npm/picomatch@4.0.7');
    expect(sourcePolicy).toContain('expired_at: 2026-12-02');
    expect(sourcePolicy.match(/\bid: CVE-/g)).toHaveLength(2);
    const sources = sections.filter((section) =>
      section.includes('trivyignores: ' + sourcePath),
    );
    expect(sources.map((section) => section.split('\n')[0])).toEqual([
      'Dependency and secret scan',
    ]);
    const apiException =
      '.github/security/staging-api-picomatch-temporary-exception.yaml';
    const apiPolicy = readFileSync(apiException, 'utf8');
    expect(apiPolicy).toContain('id: CVE-2026-112366');
    expect(apiPolicy).toContain('pkg:npm/picomatch@4.0.7');
    expect(apiPolicy).toContain('expired_at: 2026-12-02');
    expect(apiPolicy.match(/\bid: CVE-/g)).toHaveLength(1);
    const apiSection = sections.find((part) => part.startsWith('Scan API image'));
    expect(apiSection).toContain('trivyignores: ' + apiException);
    expect(apiSection).toContain("exit-code: '1'");
    const rest = ['Scan Web image', 'Scan PostgreSQL'];
    for (const name of rest) {
      const section = sections.find((part) => part.startsWith(name));
      expect(section).toBeDefined();
      expect(section).not.toContain('trivyignores:');
    }
  });
});
