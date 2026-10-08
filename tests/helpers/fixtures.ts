import { readFileSync } from 'node:fs';
export function fixture(name = 'single-event'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/pasarguard/${name}.sanitized.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}
