import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitApprovedPilotFiles } from '../../scripts/orchestrator/gate.js';

const base = '5d7101d6cd85392ab37adbc24056f39aba7d5b2a';
const spec = 'a88c1be212e72f518d8b317747ea586d19f09e37';
const id = 'TOOL_RUNTIME_UNAVAILABLE.bac88147bece';
const python = join(
  process.cwd(),
  'scripts/orchestrator/recover-pilot-git-sandbox.py',
);
const paths = [
  'scripts/pilot/phase-label.ts',
  'scripts/pilot/tsconfig.json',
  'tests/unit/pilot-phase-label.test.ts',
];

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
        data.state.transitions[0]!.actor = 'owner-supervised-git-sandbox-recovery';
        break;
    }
    const result = validateFixture(data);
    expect(result.status).not.toBe(0);
  });

  it('commits only the approved three pilot files outside the agent sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-pilot-commit-'));
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', dir, ...args], {
        encoding: 'utf8',
      }).trim();
    try {
      git('init', '-q');
      writeFileSync(join(dir, 'README.md'), 'Fixture\n');
      git('add', 'README.md');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid.local',
        'commit',
        '-qm',
        'base',
      );
      const before = git('rev-parse', 'HEAD');
      git('switch', '-q', '-c', 'agent/57-' + spec.slice(0, 12));

      for (const path of paths) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), 'fixture\n');
      }

      const input = {
        taskId: 57,
        attempt: 3,
        idempotencyKey: '57:3:IMPLEMENTATION:' + base + ':-',
        specPath: 'docs/tasks/PILOT-001-automatic-agent-chain.md',
        specSha: spec,
        baseSha: base,
        gate: 'IMPLEMENTATION' as const,
        worktree: dir,
        sourceRepo: dir,
        codexExecutable: '/bin/true',
        pnpmExecutable: '/bin/true',
      };
      const after = commitApprovedPilotFiles(input, before);
      expect(after).not.toBe(before);
      expect(git('status', '--porcelain')).toBe('');
      expect(git('show', '--pretty=format:', '--name-only').split('\n').sort())
        .toEqual([...paths].sort());

      writeFileSync(join(dir, 'unexpected.txt'), 'unsafe\n');
      expect(() => commitApprovedPilotFiles(input, after)).toThrow(
        'unexpected paths',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
