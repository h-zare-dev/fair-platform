import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const base = '5d7101d6cd85392ab37adbc24056f39aba7d5b2a';
const spec = 'a88c1be212e72f518d8b317747ea586d19f09e37';
const evidenceId = 'TOOL_RUNTIME_UNAVAILABLE.bac88147bece';
const script = join(
  process.cwd(),
  'scripts/orchestrator/recover-pilot-runtime.py',
);

function fixture() {
  const evidence = {
    verdict: 'BLOCKED',
    sha: base,
    evidenceId,
    defectCode: 'TOOL_RUNTIME_UNAVAILABLE',
  };
  return {
    state: {
      taskId: 57,
      specPath: 'docs/tasks/PILOT-001-automatic-agent-chain.md',
      specSha: spec,
      baseSha: base,
      phase: 'BLOCKED',
      attempt: 1,
      reworks: 0,
      maxReworks: 3,
      verdicts: {
        IMPLEMENTATION: {
          verdict: 'BLOCKED',
          sha: base,
          evidenceId,
        },
      },
      transitions: [
        {
          at: '2026-11-14T22:51:59.093Z',
          phase: 'BLOCKED',
          attempt: 1,
          actor: 'IMPLEMENTATION',
          evidenceId,
          errorCode: 'TOOL_RUNTIME_UNAVAILABLE',
        },
      ],
    },
    receipt: {
      key: '57:1:IMPLEMENTATION:' + base + ':-',
      gate: 'IMPLEMENTATION',
      taskId: 57,
      attempt: 1,
      specSha: spec,
      baseSha: base,
      evidence,
    },
  };
}

const check = (value: ReturnType<typeof fixture>) => {
  const runner = [
    'import json',
    'import runpy',
    'import sys',
    'module = runpy.run_path(sys.argv[1])',
    'data = json.load(sys.stdin)',
    "module['validate_checkpoint'](data['state'], data['receipt'])",
    "print('VALID')",
  ].join('\n');
  return spawnSync('/usr/bin/python3', ['-c', runner, script], {
    input: JSON.stringify(value),
    encoding: 'utf8',
    timeout: 10_000,
  });
};

describe('one-time pilot #57 runtime recovery', () => {
  it('accepts only the persisted, SHA-bound tool-host failure', () => {
    const result = check(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VALID');
  });

  it.each([
    'different phase',
    'changed attempt',
    'unresolved in-flight gate',
    'pending report',
    'changed implementation head',
    'stale transition',
    'changed verdict',
    'tampered receipt',
    'previous recovery marker',
  ])('fails closed on %s', (scenario) => {
    const value = fixture();
    switch (scenario) {
      case 'different phase':
        value.state.phase = 'IMPLEMENTING';
        break;
      case 'changed attempt':
        value.state.attempt = 2;
        break;
      case 'unresolved in-flight gate':
        Object.assign(value.state, { inFlight: { gate: 'IMPLEMENTATION' } });
        break;
      case 'pending report':
        Object.assign(value.state, {
          pendingReport: { gate: 'IMPLEMENTATION' },
        });
        break;
      case 'changed implementation head':
        Object.assign(value.state, { headSha: 'a'.repeat(40) });
        break;
      case 'stale transition':
        value.state.transitions[0]!.errorCode = 'UNRESOLVED_INFLIGHT';
        break;
      case 'changed verdict':
        value.state.verdicts.IMPLEMENTATION.verdict = 'PASS';
        break;
      case 'tampered receipt':
        value.receipt.evidence.defectCode = 'UNRESOLVED_INFLIGHT';
        break;
      case 'previous recovery marker':
        value.state.transitions.push({
          at: '2026-11-14T22:52:00Z',
          phase: 'BLOCKED',
          attempt: 1,
          actor: 'owner-supervised-runtime-recovery',
          evidenceId,
          errorCode: 'TOOL_RUNTIME_UNAVAILABLE',
        });
        break;
    }
    const result = check(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Checkpoint|RecoveryBlocked/);
  });
});
