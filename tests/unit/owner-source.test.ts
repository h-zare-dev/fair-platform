import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readOwnerSource,
  rememberOwnerSource,
  safeOwnerSource,
} from '../../apps/web/lib/owner-source.js';

afterEach(() => vi.unstubAllGlobals());

describe('Owner source selection across page navigation', () => {
  it('preserves a selected replay dataset without changing server-side isolation', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    expect(readOwnerSource()).toBeNull();
    rememberOwnerSource('replay-30d');
    expect(readOwnerSource()).toBe('replay-30d');
    rememberOwnerSource('primary');
    expect(readOwnerSource()).toBe('primary');
    rememberOwnerSource('');
    expect(readOwnerSource()).toBeNull();
  });

  it('rejects malformed, injected or oversized source IDs', () => {
    for (const value of [
      '/api/secrets',
      '../primary',
      ' primary',
      'source with spaces',
      'a'.repeat(101),
      'source\nnext',
    ]) {
      expect(safeOwnerSource(value)).toBeNull();
    }
    expect(safeOwnerSource('replay-30d')).toBe('replay-30d');
    expect(safeOwnerSource('primary')).toBe('primary');
  });

  it('fails safely on server rendering or disabled session storage', () => {
    expect(readOwnerSource()).toBeNull();
    expect(() => rememberOwnerSource('replay-30d')).not.toThrow();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readOwnerSource()).toBeNull();
    expect(() => rememberOwnerSource('replay-30d')).not.toThrow();
  });
});
