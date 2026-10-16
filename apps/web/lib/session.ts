import 'server-only';
import { cookies } from 'next/headers';

export async function ownerSession(): Promise<
  'authenticated' | 'anonymous' | 'unavailable'
> {
  const token = (await cookies()).get('__Host-fair_owner')?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return 'anonymous';
  try {
    const response = await fetch(
      'http://owner-api:3001/api/v1/owner/auth/session',
      {
        headers: { Cookie: `__Host-fair_owner=${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    const result: unknown = await response.json();
    if (response.status === 401) return 'anonymous';
    return response.ok &&
      typeof result === 'object' &&
      result !== null &&
      'authenticated' in result &&
      result.authenticated === true
      ? 'authenticated'
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
