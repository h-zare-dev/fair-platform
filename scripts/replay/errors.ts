export type ErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'UNSAFE_PATH'
  | 'INPUT_UNREADABLE'
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_MANIFEST_VERSION'
  | 'CHECKSUM_MISMATCH'
  | 'INVALID_JSONL'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_INTEGRITY_FAILED'
  | 'INPUT_CHANGED'
  | 'REPLAY_FAILED'
  | 'CLEANUP_FAILED'
  | 'OUTPUT_FAILED';
export class ReplayError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
export function fail(code: ErrorCode): never {
  throw new ReplayError(code);
}
export function safeCode(error: unknown): ErrorCode {
  return error instanceof ReplayError ? error.code : 'REPLAY_FAILED';
}
