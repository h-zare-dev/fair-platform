import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  type Evidence,
  type Ports,
} from '../../scripts/orchestrator/engine.js';
import { newTask, StateStore } from '../../scripts/orchestrator/state.js';

const sha = (digit: string) => digit.repeat(40);
describe('restart safety', () => {
  it('reacquires a stale file lock and rejects a concurrent holder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-lock-'));
    try {
      const store = new StateStore(join(dir, 'state.json'));
      writeFileSync(`${store.path}.lock`, 'stale pre-flock file');
      let release!: () => void;
      const held = store.withLock(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(store.withLock(() => Promise.resolve())).rejects.toThrow(
        'task lock',
      );
      release();
      await held;
      await expect(
        store.withLock(() => Promise.resolve('recovered')),
      ).resolves.toBe('recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a command result without repeating its side effect, then retries an interrupted report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-restart-'));
    try {
      const store = new StateStore(join(dir, 'task.json'));
      const state = newTask(53, 'docs/tasks/TASK-53.md', sha('a'), sha('b'));
      let runs = 0;
      let reports = 0;
      let recovered = 0;
      const evidence: Evidence = {
        verdict: 'PASS',
        sha: sha('c'),
        evidenceId: 'impl-1',
      };
      const ports: Ports = {
        reconcile: () => Promise.resolve(),
        developmentSha: () => Promise.resolve(sha('b')),
        run: () => {
          runs++;
          if (runs === 1) throw new Error('killed after command side effect');
          return Promise.resolve(evidence);
        },
        recover: () => {
          recovered++;
          return Promise.resolve(evidence);
        },
        report: () => {
          reports++;
          if (reports === 1)
            throw new Error('network failed after evidence write');
          return Promise.resolve();
        },
      };
      const engine = new Orchestrator(ports, (value) => store.save(value));
      await engine.step(state); // QUEUED → IMPLEMENTING
      await expect(engine.step(state)).rejects.toThrow('killed');
      expect(store.load()?.inFlight?.gate).toBe('IMPLEMENTATION');
      await expect(engine.step(store.load()!)).rejects.toThrow(
        'network failed',
      );
      expect(store.load()?.pendingReport?.evidence.evidenceId).toBe('impl-1');
      const resumed = store.load()!;
      await engine.step(resumed);
      expect(resumed.phase).toBe('REVIEWING');
      expect(runs).toBe(1);
      expect(recovered).toBe(1);
      expect(reports).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('restarts after a Lab E2E side effect and completes the full rework cycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-lab-restart-'));
    try {
      const store = new StateStore(join(dir, 'task.json'));
      const state = newTask(57, 'docs/tasks/TASK-57.md', sha('a'), sha('b'));
      const seen: string[] = [];
      let interrupted = false;
      const ports: Ports = {
        reconcile: () => Promise.resolve(),
        developmentSha: () => Promise.resolve(sha('b')),
        report: () => Promise.resolve(),
        run: (gate, current) => {
          seen.push(`${current.attempt}:${gate}`);
          if (gate === 'LAB_E2E' && current.attempt === 1 && !interrupted) {
            interrupted = true;
            throw new Error('process interrupted');
          }
          const head = current.attempt === 1 ? sha('c') : sha('d');
          const candidate = current.attempt === 1 ? sha('e') : sha('f');
          return Promise.resolve({
            verdict: 'PASS',
            sha:
              gate === 'IMPLEMENTATION'
                ? head
                : gate === 'LAB_DEPLOY' || gate === 'LAB_E2E'
                  ? candidate
                  : head,
            evidenceId: `${current.attempt}-${gate}`,
            ...(gate === 'CANDIDATE' ? { candidateSha: candidate } : {}),
            ...(gate === 'LAB_DEPLOY'
              ? { deploymentDigest: `sha256:${'1'.repeat(64)}` }
              : {}),
          });
        },
        recover: (gate, current) =>
          Promise.resolve({
            verdict: 'FAIL',
            sha: current.candidateSha!,
            evidenceId: `${current.attempt}-${gate}-recovered`,
            defectCode: 'SYNTHETIC_DELIVERY',
          }),
      };
      const engine = new Orchestrator(ports, (value) => store.save(value));
      for (let i = 0; i < 30 && state.phase !== 'READY_FOR_OWNER_REVIEW'; i++) {
        try {
          await engine.step(store.load() ?? state);
        } catch (error) {
          expect((error as Error).message).toBe('process interrupted');
        }
      }
      const finished = store.load()!;
      expect(finished.phase).toBe('READY_FOR_OWNER_REVIEW');
      expect(finished.reworks).toBe(1);
      expect(seen.filter((item) => item === '1:LAB_E2E')).toHaveLength(1);
      expect(seen).toContain('2:REVIEW');
      expect(seen).toContain('2:QA');
      expect(seen).toContain('2:LAB_E2E');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes a post-QA Draft PR error from its saved receipt without running QA twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-publish-interrupt-'));
    try {
      const store = new StateStore(join(dir, 'state.json'));
      const state = newTask(59, 'docs/tasks/TASK-59.md', sha('a'), sha('b'));
      let modelCalls = 0;
      let publications = 0;
      const evidence: Evidence = {
        verdict: 'PASS',
        sha: sha('c'),
        evidenceId: 'persisted-implementation',
      };
      const ports: Ports = {
        reconcile: () => Promise.resolve(),
        developmentSha: () => Promise.resolve(sha('b')),
        run: (gate) => {
          modelCalls++;
          return Promise.resolve(
            gate === 'IMPLEMENTATION'
              ? evidence
              : { ...evidence, evidenceId: `persisted-${gate}` },
          );
        },
        recover: (gate) =>
          Promise.resolve({
            ...evidence,
            evidenceId: `persisted-${gate}`,
          }),
        report: () => Promise.resolve(),
        publish: () => {
          publications++;
          if (publications === 1) throw new Error('PR is not exact draft head');
          return Promise.resolve();
        },
      };
      const engine = new Orchestrator(ports, (s) => store.save(s));
      await engine.step(state);
      await engine.step(state);
      await engine.step(state);
      await expect(engine.step(state)).rejects.toThrow(
        'PR is not exact draft head',
      );
      const persisted = store.load()!;
      expect(persisted.headSha).toBe(sha('c'));
      expect(persisted.inFlight?.gate).toBe('QA');
      await engine.step(persisted);
      expect(persisted.phase).toBe('CI');
      expect(persisted.headSha).toBe(sha('c'));
      expect(modelCalls).toBe(3);
      expect(publications).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
