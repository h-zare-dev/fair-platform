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

// All identities and values come from synthetic fixtures.
export function actorContractBatch(): {
  payload: Record<string, unknown>[];
  accepted: number[];
} {
  const actors = [
    { id: 502, username: 'synthetic-actor' },
    { id: null, username: 'synthetic-actor' },
    null,
    undefined,
    {},
    { id: null },
    { username: 'synthetic' },
    { id: '502', username: 'synthetic' },
    { id: -1, username: 'synthetic' },
  ];
  const payload = actors.map((by, index) => {
    const event = fixture();
    (event.user as Record<string, unknown>).id = 12000 + index;
    if (by === undefined) delete event.by;
    else event.by = by;
    return event;
  });
  for (const admin of [
    undefined,
    null,
    { id: null, username: 'synthetic' },
    { id: '501', username: 'synthetic' },
  ]) {
    const event = fixture();
    const user = event.user as Record<string, unknown>;
    user.id = 12000 + payload.length;
    if (admin === undefined) delete user.admin;
    else user.admin = admin;
    event.by = { id: null, username: 'synthetic-actor' };
    payload.push(event);
  }
  return { payload, accepted: [12000, 12001, 12002, 12003] };
}
