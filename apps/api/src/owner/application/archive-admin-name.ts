/** An archived pseudonym is not a verified current PasarGuard administrator. */
export function isArchivedPseudonym(name: string): boolean {
  return /^anon-[0-9a-f]{8,64}$/i.test(name);
}

export function archivedAdminNameStatus(
  names: readonly string[] | null,
  resolvedSourceStatus: 'VERIFIED_IN_ARCHIVE' | 'SOURCE',
):
  | 'ARCHIVE_PSEUDONYMIZED'
  | 'CONFLICT'
  | 'MISSING'
  | typeof resolvedSourceStatus {
  if (!names?.length) return 'MISSING';
  if (names.length > 1) return 'CONFLICT';
  return isArchivedPseudonym(names[0]!)
    ? 'ARCHIVE_PSEUDONYMIZED'
    : resolvedSourceStatus;
}
