import type {
  AccountingException,
  AccountingExceptionInput,
  Charge,
  ShadowChargeInput,
} from '../domain/contracts.js';
export interface RecordedCharge extends Charge {
  readonly id: string;
  readonly recordedAt: string;
}
export interface RecordedException extends AccountingException {
  readonly id: string;
  readonly createdAt: string;
}
export interface RecordingResult<T> {
  readonly outcome: 'RECORDED' | 'ALREADY_RECORDED';
  readonly record: T;
}
export interface ShadowLedger {
  recordShadowCharge(
    input: ShadowChargeInput,
  ): Promise<RecordingResult<RecordedCharge>>;
}
export interface AccountingExceptions {
  recordAccountingException(
    input: AccountingExceptionInput,
  ): Promise<RecordingResult<RecordedException>>;
}
