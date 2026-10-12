import { fail, type ErrorCode } from './errors.js';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate JSON syntax first, then scan keys including escaped spellings. No raw diagnostics escape. */
export function parseJson(text: string, code: ErrorCode): unknown {
  try {
    const result: unknown = JSON.parse(text);
    let at = 0;
    const whitespace = () => {
      while (/\s/.test(text[at] ?? '') && at < text.length) at++;
    };
    const string = (): string => {
      const start = at++;
      while (at < text.length) {
        const c = text[at++];
        if (c === '\\') at++;
        else if (c === '"') return JSON.parse(text.slice(start, at)) as string;
      }
      return fail(code);
    };
    const value = (depth: number): void => {
      if (depth > 64) fail(code);
      whitespace();
      if (text[at] === '"') {
        string();
        return;
      }
      if (text[at] === '{') {
        at++;
        whitespace();
        const keys = new Set<string>();
        while (text[at] !== '}') {
          const key = string();
          if (keys.has(key)) fail(code);
          keys.add(key);
          whitespace();
          at++;
          value(depth + 1);
          whitespace();
          if (text[at] !== ',') break;
          at++;
          whitespace();
        }
        at++;
        return;
      }
      if (text[at] === '[') {
        at++;
        whitespace();
        while (text[at] !== ']') {
          value(depth + 1);
          whitespace();
          if (text[at] !== ',') break;
          at++;
          whitespace();
        }
        at++;
        return;
      }
      while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    };
    value(0);
    return result;
  } catch {
    return fail(code);
  }
}

export function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Reject Date's permissive invalid-day rollover and preserve only UTC exporter/ISO forms. */
export function utcDate(value: unknown, code: ErrorCode): Date {
  if (typeof value !== 'string') fail(code);
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00)$/.exec(
      value,
    );
  if (!match) fail(code);
  const base = `${match[1]}T${match[2]}`;
  const date = new Date(
    `${base}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`,
  );
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== base
  )
    fail(code);
  return date;
}
export function actionOf(child: Record<string, unknown>): string {
  if (!Object.hasOwn(child, 'action')) return '(missing)';
  if (
    typeof child.action !== 'string' ||
    !/^[A-Za-z0-9_:-]{1,64}$/.test(child.action)
  )
    fail('INVALID_JSONL');
  return child.action;
}
export function actorNull(child: Record<string, unknown>): boolean {
  return (
    object(child.by) && Object.hasOwn(child.by, 'id') && child.by.id === null
  );
}
