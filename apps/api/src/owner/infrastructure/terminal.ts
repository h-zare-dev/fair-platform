import { emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

/** Require a real terminal. Raw mode disables echo; restore it on every exit path. */
export async function hiddenPassword(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<string> {
  if (!input.isTTY || !output.isTTY)
    throw new Error('TRUSTED_TERMINAL_REQUIRED');
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onKey = (
        text: string | undefined,
        key: { name?: string; ctrl?: boolean },
      ) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
          finish();
          reject(new Error('CANCELLED'));
        } else if (key.name === 'return' || key.name === 'enter') {
          finish();
          resolve(value);
        } else if (key.name === 'backspace')
          value = Array.from(value).slice(0, -1).join('');
        else if (text && !key.ctrl && !/[\x00-\x1f\x7f]/.test(text)) {
          if (value.length + text.length > 1024) {
            finish();
            reject(new Error('PASSWORD_TOO_LONG'));
          } else value += text;
        }
      };
      const signals = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;
      const onSignal = () => {
        finish();
        reject(new Error('CANCELLED'));
      };
      function finish() {
        for (const signal of signals) process.removeListener(signal, onSignal);
        input.removeListener('keypress', onKey);
        output.write('\n');
      }
      input.on('keypress', onKey);
      for (const signal of signals) process.once(signal, onSignal);
      output.write('Password (hidden input): ');
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}
export async function confirmedPassword(): Promise<string> {
  const first = await hiddenPassword();
  if (first.length < 16) throw new Error('PASSWORD_MINIMUM_16_CHARACTERS');
  process.stdout.write('Confirm ');
  if (first !== (await hiddenPassword()))
    throw new Error('PASSWORD_CONFIRMATION_MISMATCH');
  return first;
}
