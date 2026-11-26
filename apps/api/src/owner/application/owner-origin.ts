import { isIP } from 'node:net';
import { z } from 'zod';

// Exact, operator-approved browser origin: never accept an arbitrary Origin or
// infer trust from Host/X-Forwarded-Host headers.
export function isCanonicalOwnerOrigin(value: string): boolean {
  if (value.length > 262 || !value.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    host !== host.toLowerCase()
  ) {
    return false;
  }
  if (isIP(host) === 4) return host !== '0.0.0.0';
  if (host === 'localhost') return true;
  if (host.length > 253 || !host.includes('.')) return false;
  const labels = host.split('.');
  if (/^\d+$/.test(labels.at(-1) ?? '')) return false;
  return labels.every(
    (label) =>
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export const ownerOriginSchema = z.string().refine(isCanonicalOwnerOrigin, {
  message: 'OWNER_ORIGIN_INVALID_CANONICAL_HTTPS_HOST',
});
