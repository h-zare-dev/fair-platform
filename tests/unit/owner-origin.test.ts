import { describe, expect, it } from 'vitest';
import { isCanonicalOwnerOrigin } from '../../apps/api/src/owner/application/owner-origin.js';

describe('operator-configured Owner UI origin', () => {
  it.each([
    'https://panel.fairisfair.ir',
    'https://panel2.fairisfair.ir',
    'https://example.com',
    'https://91.107.132.246',
    'https://127.0.0.1',
    'https://localhost',
  ])('allows a canonical HTTPS hostname or IPv4 origin: %s', (origin) => {
    expect(isCanonicalOwnerOrigin(origin)).toBe(true);
  });

  it.each([
    'http://panel2.fairisfair.ir',
    'https://panel2.fairisfair.ir:443',
    'https://panel2.fairisfair.ir/login',
    'https://panel2.fairisfair.ir/?next=evil',
    'https://panel2.fairisfair.ir#x',
    'https://user:pass@panel2.fairisfair.ir',
    'https://panel2.fairisfair.ir.evil.com/',
    'https://example..com',
    'https://example.123',
    'https://-example.com',
    'https://0.0.0.0',
    'https://EXAMPLE.com',
    'https://127.0.0.1:4443',
    'https://[::1]',
    ' https://example.com',
    'https://example.com ',
  ])('rejects an invalid/untrusted owner origin: %s', (origin) => {
    expect(isCanonicalOwnerOrigin(origin)).toBe(false);
  });
});
