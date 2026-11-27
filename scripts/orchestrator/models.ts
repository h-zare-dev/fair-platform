import { readFileSync } from 'node:fs';

export type Role =
  'IMPLEMENTATION' | 'REVIEW' | 'QA' | 'LAB' | 'REPLAY' | 'FALLBACK' | 'REPORT';
export type ModelRoute = { model: string; effort: 'low' | 'none' };

export function loadModelRoutes(path: string): Record<Role, ModelRoute> {
  const entries: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z_]+)=([a-z0-9-]+)$/.exec(line);
    if (!match) throw new Error('Invalid model configuration line');
    entries[match[1]!] = match[2]!;
  }
  const result = {} as Record<Role, ModelRoute>;
  for (const role of [
    'IMPLEMENTATION',
    'REVIEW',
    'QA',
    'LAB',
    'REPLAY',
    'FALLBACK',
    'REPORT',
  ] as const) {
    const model = entries[`${role}_MODEL`];
    const effort = entries[`${role}_EFFORT`];
    if (
      !model ||
      !['gpt-6-sol', 'gpt-6-luna'].includes(model) ||
      !effort ||
      !['low', 'none'].includes(effort)
    )
      throw new Error(`Invalid ${role} model route`);
    result[role] = { model, effort: effort as ModelRoute['effort'] };
  }
  if (
    result.IMPLEMENTATION.model !== 'gpt-6-sol' ||
    result.REVIEW.model !== 'gpt-6-sol' ||
    ['QA', 'LAB', 'REPLAY'].some(
      (role) => result[role as Role].model !== 'gpt-6-luna',
    )
  )
    throw new Error('Owner model routing mismatch');
  return result;
}
