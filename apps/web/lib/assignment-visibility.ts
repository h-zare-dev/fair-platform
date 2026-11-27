/**
 * An inclusive local end date is stored as the exclusive instant at the next
 * midnight. Compare instants, never host-local dates or a browser timezone.
 * A future-start assignment is still visible as scheduled.
 */
export function assignmentExpired(
  effectiveUntil: string | null,
  nowMs: number,
): boolean {
  if (effectiveUntil === null) return false;
  const untilMs = Date.parse(effectiveUntil);
  // Keep malformed server responses visible instead of silently hiding data.
  return Number.isFinite(untilMs) && untilMs <= nowMs;
}

export function partitionAssignments<
  T extends { effectiveUntil: string | null },
>(assignments: readonly T[], nowMs: number): { visible: T[]; expired: T[] } {
  const visible: T[] = [];
  const expired: T[] = [];
  for (const assignment of assignments) {
    (assignmentExpired(assignment.effectiveUntil, nowMs)
      ? expired
      : visible
    ).push(assignment);
  }
  return { visible, expired };
}
