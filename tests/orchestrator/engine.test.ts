import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  type Evidence,
  type Ports,
} from '../../scripts/orchestrator/engine.js';
import {
  newTask,
  StateStore,
  type Gate,
} from '../../scripts/orchestrator/state.js';

const sha = (digit: string) => digit.repeat(40);
describe('orchestrator', () => {
  it('routes Lab E2E failure to Implementation and reruns all independent gates on the new SHA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-orch-'));
    try {
      const store = new StateStore(join(dir, 'task.json'));
      const state = newTask(53, 'docs/tasks/ISSUE-53.md', sha('a'), sha('b'));
      const seen: Gate[] = [];
      const ports: Ports = {
        reconcile: async () => {},
        developmentSha: () => Promise.resolve(sha('b')),
        report: async () => {},
        run: (gate, current): Promise<Evidence> => {
          seen.push(gate);
          const head = current.attempt === 1 ? sha('c') : sha('d');
          const candidate = current.attempt === 1 ? sha('e') : sha('f');
          if (gate === 'IMPLEMENTATION')
            return Promise.resolve({
              verdict: 'PASS',
              sha: head,
              evidenceId: `impl-${current.attempt}`,
            });
          if (gate === 'CANDIDATE')
            return Promise.resolve({
              verdict: 'PASS',
              sha: head,
              candidateSha: candidate,
              evidenceId: `candidate-${current.attempt}`,
            });
          if (gate === 'LAB_DEPLOY')
            return Promise.resolve({
              verdict: 'PASS',
              sha: candidate,
              deploymentDigest: `sha256:${'1'.repeat(64)}`,
              evidenceId: `deploy-${current.attempt}`,
            });
          return Promise.resolve({
            verdict:
              gate === 'LAB_E2E' && current.attempt === 1 ? 'FAIL' : 'PASS',
            sha: gate === 'LAB_E2E' ? candidate : head,
            evidenceId: `${gate}-${current.attempt}`,
            defectCode: gate === 'LAB_E2E' ? 'SYNTHETIC_DELIVERY' : undefined,
          });
        },
      };
      const engine = new Orchestrator(ports, (value) => store.save(value));
      for (let i = 0; i < 30 && state.phase !== 'READY_FOR_OWNER_REVIEW'; i++)
        await engine.step(state);
      expect(state.phase).toBe('READY_FOR_OWNER_REVIEW');
      expect(state.reworks).toBe(1);
      expect(seen).toEqual([
        'IMPLEMENTATION',
        'REVIEW',
        'QA',
        'CI',
        'CANDIDATE',
        'LAB_DEPLOY',
        'LAB_E2E',
        'IMPLEMENTATION',
        'REVIEW',
        'QA',
        'CI',
        'CANDIDATE',
        'LAB_DEPLOY',
        'LAB_E2E',
      ]);
      expect(store.load()?.headSha).toBe(sha('d'));
      expect(state.verdicts.REVIEW?.sha).toBe(sha('d'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidates completed Lab evidence when development advances during Owner review', async () => {
    const state = newTask(57, 'docs/tasks/TASK-57.md', sha('a'), sha('b'));
    state.phase = 'READY_FOR_OWNER_REVIEW';
    state.headSha = sha('c');
    state.candidateSha = sha('d');
    state.verdicts.REVIEW = {
      verdict: 'PASS',
      sha: sha('c'),
      evidenceId: 'old-review',
    };
    const ports: Ports = {
      reconcile: () => Promise.resolve(),
      developmentSha: () => Promise.resolve(sha('e')),
      verifyOwnerMerge: () => Promise.resolve(undefined),
      report: () => Promise.resolve(),
      run: () => {
        throw new Error('stale task must not run');
      },
    };
    const engine = new Orchestrator(ports, () => {});
    await engine.step(state);
    expect(state.phase).toBe('REWORK');
    expect(state.attempt).toBe(2);
    expect(state.reworks).toBe(1);
    expect(state.verdicts).toEqual({});
    expect(state.candidateSha).toBeUndefined();
    expect(state.transitions.at(-1)?.errorCode).toBe('BASE_DRIFT');
  });

  it('refuses a pending recovery report once the approved base drifts', async () => {
    const state = newTask(58, 'docs/tasks/TASK-58.md', sha('a'), sha('b'));
    state.phase = 'QA';
    state.headSha = sha('c');
    state.pendingReport = {
      gate: 'REVIEW',
      key: 'previous-review',
      evidence: {
        verdict: 'PASS',
        sha: sha('c'),
        evidenceId: 'stale-review',
      },
    };
    let reported = false;
    const ports: Ports = {
      reconcile: () => Promise.resolve(),
      developmentSha: () => Promise.resolve(sha('e')),
      report: () => {
        reported = true;
        return Promise.resolve();
      },
      run: () => {
        throw new Error('no stale gate run');
      },
    };
    await new Orchestrator(ports, () => {}).step(state);
    expect(reported).toBe(false);
    expect(state.pendingReport).toBeUndefined();
    expect(state.phase).toBe('REWORK');
    expect(state.transitions.at(-1)?.errorCode).toBe('BASE_DRIFT');
  });

  it('refuses exhausted model capacity before persisting an in-flight gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-budget-'));
    try {
      const store = new StateStore(join(dir, 'state.json'));
      const state = newTask(62, 'docs/tasks/TASK-62.md', sha('a'), sha('b'));
      state.phase = 'IMPLEMENTING';
      let started = 0;
      let allowed = false;
      const ports: Ports = {
        reconcile: () => Promise.resolve(),
        developmentSha: () => Promise.resolve(sha('b')),
        preflightRun: () => {
          if (!allowed)
            throw new Error('Daily model call budget exhausted');
          return Promise.resolve();
        },
        run: () => {
          started++;
          return Promise.resolve({
            verdict: 'PASS',
            sha: sha('c'),
            evidenceId: 'model-run',
          });
        },
        publish: () => Promise.resolve(),
        report: () => Promise.resolve(),
      };
      const engine = new Orchestrator(ports, (s) => store.save(s));
      await expect(engine.step(state)).rejects.toThrow(
        'Daily model call budget exhausted',
      );
      expect(started).toBe(0);
      expect(state.inFlight).toBeUndefined();
      expect(store.load()?.inFlight).toBeUndefined();
      allowed = true;
      await engine.step(state);
      expect(started).toBe(1);
      expect(state.phase).toBe('REVIEWING');
      expect(state.headSha).toBe(sha('c'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks after the bounded rework budget is exhausted', async () => {
    const state = newTask(53, 'docs/tasks/ISSUE-53.md', sha('a'), sha('b'), 1);
    const ports: Ports = {
      reconcile: () => Promise.resolve(),
      developmentSha: () => Promise.resolve(sha('b')),
      report: () => Promise.resolve(),
      run: (gate, current) =>
        Promise.resolve({
          verdict: gate === 'IMPLEMENTATION' ? 'PASS' : 'FAIL',
          sha: current.attempt === 1 ? sha('c') : sha('d'),
          evidenceId: `${gate}-${current.attempt}`,
        }),
    };
    const engine = new Orchestrator(ports, () => {});
    for (let i = 0; i < 10 && state.phase !== 'BLOCKED'; i++)
      await engine.step(state);
    expect(state.phase).toBe('BLOCKED');
    expect(state.reworks).toBe(2);
    expect(state.transitions.at(-1)?.errorCode).toBe('REWORK_EXHAUSTED');
  });
});
