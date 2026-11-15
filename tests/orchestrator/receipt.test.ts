import { describe, expect, it } from 'vitest';
import {
  receiptFor,
  verifyReceipt,
} from '../../scripts/orchestrator/runner.js';
import { newTask } from '../../scripts/orchestrator/state.js';

const sha = (digit: string): string => digit.repeat(40);

describe('durable gate receipt validation', () => {
  it('rejects cross-attempt receipts before trusting any saved verdict', () => {
    const state = newTask(61, 'docs/tasks/TASK-61.md', sha('a'), sha('b'));
    state.headSha = sha('c');
    const receipt = receiptFor(state, 'REVIEW', 'original-key', {
      verdict: 'PASS',
      sha: sha('c'),
      evidenceId: 'review-61-1',
    });
    const config = {} as Parameters<typeof verifyReceipt>[0];
    expect(() =>
      verifyReceipt(config, state, 'REVIEW', 'different-key', receipt),
    ).toThrow('Stale or untrusted gate recovery receipt');
    state.attempt = 2;
    expect(() =>
      verifyReceipt(config, state, 'REVIEW', 'original-key', receipt),
    ).toThrow('Stale or untrusted gate recovery receipt');
  });

  it('rejects saved evidence if the approved spec or base changes', () => {
    const state = newTask(62, 'docs/tasks/TASK-62.md', sha('a'), sha('b'));
    state.headSha = sha('c');
    const receipt = receiptFor(state, 'QA', 'qa-62', {
      verdict: 'PASS',
      sha: sha('c'),
      evidenceId: 'qa-62-1',
    });
    const config = {} as Parameters<typeof verifyReceipt>[0];
    state.baseSha = sha('d');
    expect(() => verifyReceipt(config, state, 'QA', 'qa-62', receipt)).toThrow(
      'Stale or untrusted gate recovery receipt',
    );
  });

  it('does not trust offline Lab evidence as a remotely verified result', () => {
    const state = newTask(63, 'docs/tasks/TASK-63.md', sha('a'), sha('b'));
    state.headSha = sha('c');
    state.candidateSha = sha('d');
    const receipt = receiptFor(state, 'LAB_E2E', 'lab-63', {
      verdict: 'PASS',
      sha: sha('d'),
      evidenceId: 'lab-63-1',
    });
    expect(() =>
      verifyReceipt(
        {} as Parameters<typeof verifyReceipt>[0],
        state,
        'LAB_E2E',
        'lab-63',
        receipt,
      ),
    ).toThrow('Remote gate recovery requires independent verification');
  });
});
