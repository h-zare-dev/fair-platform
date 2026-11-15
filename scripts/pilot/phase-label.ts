export function formatPilotPhase(value: string): string {
  switch (value) {
    case 'QUEUED':
      return 'Queued';
    case 'IMPLEMENTING':
      return 'Implementing';
    case 'REVIEWING':
      return 'Reviewing';
    case 'QA':
      return 'Quality assurance';
    case 'BLOCKED':
      return 'Blocked';
    default:
      return 'Unknown';
  }
}
