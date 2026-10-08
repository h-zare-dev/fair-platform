import { readFileSync } from 'node:fs';
export function fixture(name = 'single-event'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/pasarguard/${name}.sanitized.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

export const projectedTextPaths = [
  ['action'],
  ['user', 'username'],
  ['user', 'status'],
  ['user', 'admin', 'username'],
  ['by', 'username'],
  ['user', 'data_limit_reset_strategy'],
] as const;

export function nulBearingEvent(
  path: readonly string[],
): Record<string, unknown> {
  const event = fixture();
  let parent = event;
  for (const key of path.slice(0, -1))
    parent = parent[key] as Record<string, unknown>;
  parent[path.at(-1)!] = 'synthetic-private\u0000marker';
  return event;
}
