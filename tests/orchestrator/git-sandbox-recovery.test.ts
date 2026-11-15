import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const base = '5d7101d6cd85392ab37adbc24056f39aba7d5b2a';
const spec = 'a88c1be212e72f518d8b317747ea586d19f09e37';
const id = 'TOOL_RUNTIME_UNAVAILABLE.bac88147bece';
const python = join(
  process.cwd(),
  'scripts/orchestrator/recover-pilot-git-sandbox.py',
);

function checkpoint() {
  return {
    state: {
      taskId: 57,
      phase: 'IMPLEMENTING',
      attempt: 2,
      reworks: 0,
      maxReworks: 3,
      specPath: 'docs/tasks/PILOT-001-automatic-agent-chain.md',
      specSha: spec,
      baseSha: base,
      verdicts: {},
      inFlight: {
        gate: 'IMPLEMENTATION',
        key: '57:2:IMPLEMENTATION:' + base + ':-',
        startedAt: '2026-11-14T23:47:03Z',
      },
      transitions: [
        {
          at: '2026-11-14T23:47:03Z',
          attempt: 2,
          phase: 'IMPLEMENTING',
          actor: 'owner-supervised-runtime-recovery',
          errorCode: 'TOOL_RUNTIME_RECOVERED',
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
      evidence: {
        verdict: 'BLOCKED',
        sha: base,
        evidenceId: id,
        defectCode: 'TOOL_RUNTIME_UNAVAILABLE',
      },
    },
  };
}

function validateFixture(data: ReturnType<typeof checkpoint>) {
  const runner = [
    'import json, runpy, sys',
    'module = runpy.run_path(sys.argv[1])',
    'fixture = json.load(sys.stdin)',
    "module['validate_checkpoint'](fixture['state'], fixture['receipt'])",
    "print('VALID')",
  ].join('\n');
  return spawnSync('/usr/bin/python3', ['-c', runner, python], {
    input: JSON.stringify(data),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('pilot #57 linked-worktree Git sandbox recovery', () => {
  it('accepts only the known in-flight attempt-2 checkpoint', () => {
    const result = validateFixture(checkpoint());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VALID');
  });

  it.each([
    'different attempt',
    'changed phase',
    'changed base',
    'wrong gate key',
    'pending report',
    'unexpected head',
    'tampered evidence',
    'missing in-flight gate',
    'duplicate recovery',
  ])('rejects %s', (scenario) => {
    const data = checkpoint();
    switch (scenario) {
      case 'different attempt':
        data.state.attempt = 3;
        break;
      case 'changed phase':
        data.state.phase = 'BLOCKED';
        break;
      case 'changed base':
        data.state.baseSha = 'a'.repeat(40);
        break;
      case 'wrong gate key':
        data.state.inFlight.key = 'wrong-key';
        break;
      case 'pending report':
        Object.assign(data.state, { pendingReport: { gate: 'QA' } });
        break;
      case 'unexpected head':
        Object.assign(data.state, { headSha: 'a'.repeat(40) });
        break;
      case 'tampered evidence':
        data.receipt.evidence.defectCode = 'OTHER_FAILURE';
        break;
      case 'missing in-flight gate':
        data.state.inFlight.gate = 'REVIEW';
        break;
      case 'duplicate recovery':
        data.state.transitions[0]!.actor =
          'owner-supervised-git-sandbox-recovery';
        break;
    }
    const result = validateFixture(data);
    expect(result.status).not.toBe(0);
  });
});
