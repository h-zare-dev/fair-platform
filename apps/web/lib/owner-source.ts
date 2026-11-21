// A UI preference only. Financial and webhook source isolation stays enforced
// by the API; never copy configuration or events between sources here.
const KEY = 'fair-platform.owner.selected-source';
const VALID_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

export function safeOwnerSource(value: string | null): string | null {
  if (value === null || !VALID_SOURCE.test(value)) return null;
  return value;
}

export function readOwnerSource(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return safeOwnerSource(window.sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function rememberOwnerSource(value: string): void {
  if (typeof window === 'undefined') return;
  const source = safeOwnerSource(value);
  try {
    if (source) window.sessionStorage.setItem(KEY, source);
    else if (!value) window.sessionStorage.removeItem(KEY);
  } catch {
    // The page still works if browser privacy settings disable storage.
  }
}
