import {
  isSha,
  type Gate,
  type Phase,
  type TaskState,
  type Verdict,
} from './state.js';

export type Evidence = {
  verdict: Verdict;
  sha: string;
  evidenceId: string;
  defectCode?: string | undefined;
  candidateSha?: string | undefined;
  deploymentDigest?: string | undefined;
};
export interface Ports {
  reconcile(state: TaskState): Promise<void>;
  run(gate: Gate, state: Readonly<TaskState>, key: string): Promise<Evidence>;
  recover?(
    gate: Gate,
    state: Readonly<TaskState>,
    key: string,
  ): Promise<Evidence | undefined>;
  report(
    state: Readonly<TaskState>,
    gate: Gate,
    evidence: Evidence,
  ): Promise<void>;
  developmentSha(): Promise<string>;
  verifyOwnerMerge?(state: Readonly<TaskState>): Promise<string | undefined>;
  publish?(state: TaskState): Promise<void>;
}

const gateFor: Partial<Record<Phase, Gate>> = {
  IMPLEMENTING: 'IMPLEMENTATION',
  REVIEWING: 'REVIEW',
  QA: 'QA',
  CI: 'CI',
  CANDIDATE_TESTING: 'CANDIDATE',
  LAB_DEPLOYING: 'LAB_DEPLOY',
  LAB_E2E: 'LAB_E2E',
  POST_MERGE_VERIFY: 'POST_MERGE',
};
const next: Partial<Record<Gate, Phase>> = {
  IMPLEMENTATION: 'REVIEWING',
  REVIEW: 'QA',
  QA: 'CI',
  CI: 'CANDIDATE_TESTING',
  CANDIDATE: 'LAB_DEPLOYING',
  LAB_DEPLOY: 'LAB_E2E',
  LAB_E2E: 'READY_FOR_OWNER_REVIEW',
  POST_MERGE: 'DONE',
};

export class Orchestrator {
  constructor(
    private readonly ports: Ports,
    private readonly save: (state: TaskState) => void,
  ) {}
  private transition(
    state: TaskState,
    phase: Phase,
    actor: string,
    evidence?: Evidence,
  ): void {
    state.phase = phase;
    state.transitions.push({
      at: new Date().toISOString(),
      attempt: state.attempt,
      phase,
      actor,
      headSha: state.headSha,
      candidateSha: state.candidateSha,
      evidenceId: evidence?.evidenceId,
      errorCode: evidence?.defectCode,
    });
    this.save(state);
  }
  async step(state: TaskState): Promise<void> {
    await this.ports.reconcile(state);
    if (state.pendingReport) {
      const { gate, evidence } = state.pendingReport;
      if (
        gate !== 'POST_MERGE' &&
        (await this.ports.developmentSha()) !== state.baseSha
      ) {
        state.pendingReport = undefined;
        state.inFlight = undefined;
        this.rework(state, {
          verdict: 'FAIL',
          sha: state.headSha ?? state.baseSha,
          evidenceId: 'development-changed',
          defectCode: 'BASE_DRIFT',
        });
        return;
      }
      await this.ports.report(state, gate, evidence);
      state.pendingReport = undefined;
      await this.finish(state, gate, evidence);
      return;
    }
    if (state.phase === 'QUEUED') {
      if ((await this.ports.developmentSha()) !== state.baseSha) {
        this.transition(state, 'BLOCKED', 'orchestrator', {
          verdict: 'BLOCKED',
          sha: state.baseSha,
          evidenceId: 'approved-base-stale',
          defectCode: 'APPROVED_BASE_STALE',
        });
        return;
      }
      this.transition(state, 'IMPLEMENTING', 'orchestrator');
      return;
    }
    if (state.phase === 'REWORK') {
      this.transition(state, 'IMPLEMENTING', 'orchestrator');
      return;
    }
    if (state.phase === 'READY_FOR_OWNER_REVIEW') {
      const merged = await this.ports.verifyOwnerMerge?.(state);
      if (merged) {
        await this.ownerMerged(state, () => Promise.resolve(merged));
      } else if ((await this.ports.developmentSha()) !== state.baseSha) {
        this.rework(state, {
          verdict: 'FAIL',
          sha: state.headSha!,
          evidenceId: 'development-changed',
          defectCode: 'BASE_DRIFT',
        });
      }
      return;
    }
    if (['DONE', 'BLOCKED', 'OWNER_MERGED'].includes(state.phase)) return;
    const gate = gateFor[state.phase];
    if (!gate) throw new Error(`Unsupported phase ${state.phase}`);
    if (
      gate !== 'IMPLEMENTATION' &&
      gate !== 'POST_MERGE' &&
      (await this.ports.developmentSha()) !== state.baseSha
    ) {
      this.rework(state, {
        verdict: 'FAIL',
        sha: state.headSha!,
        evidenceId: 'development-changed',
        defectCode: 'BASE_DRIFT',
      });
      return;
    }
    const key = `${state.taskId}:${state.attempt}:${gate}:${state.headSha ?? state.baseSha}:${state.candidateSha ?? '-'}`;
    let evidence: Evidence | undefined;
    if (state.inFlight) {
      if (state.inFlight.key !== key || state.inFlight.gate !== gate)
        throw new Error('In-flight command identity mismatch');
      evidence = await this.ports.recover?.(gate, state, key);
      if (!evidence) {
        this.transition(state, 'BLOCKED', 'orchestrator', {
          verdict: 'BLOCKED',
          sha: state.headSha ?? state.baseSha,
          evidenceId: key,
          defectCode: 'UNRESOLVED_INFLIGHT',
        });
        return;
      }
    } else {
      state.inFlight = { gate, key, startedAt: new Date().toISOString() };
      this.save(state);
      evidence = await this.ports.run(gate, state, key);
    }
    if (!evidence.evidenceId || !isSha(evidence.sha))
      throw new Error('Missing immutable evidence identity');
    const expected =
      gate === 'POST_MERGE'
        ? await this.ports.developmentSha()
        : gate === 'LAB_DEPLOY' || gate === 'LAB_E2E'
          ? state.candidateSha
          : state.headSha;
    if (gate !== 'IMPLEMENTATION' && evidence.sha !== expected)
      throw new Error(`Stale ${gate} verdict`);
    if (gate === 'IMPLEMENTATION' && evidence.verdict === 'PASS') {
      if (!isSha(evidence.sha) || evidence.sha === state.headSha)
        throw new Error('Implementation must produce a new head SHA');
      state.headSha = evidence.sha;
      state.candidateSha = undefined;
      state.deploymentDigest = undefined;
      state.verdicts = {};
      await this.ports.publish?.(state);
    }
    if (gate === 'CANDIDATE' && evidence.verdict === 'PASS') {
      if (!isSha(evidence.candidateSha ?? ''))
        throw new Error('Missing candidate SHA');
      state.candidateSha = evidence.candidateSha;
    }
    if (gate === 'LAB_DEPLOY' && evidence.verdict === 'PASS') {
      if (!/^sha256:[a-f0-9]{64}$/.test(evidence.deploymentDigest ?? ''))
        throw new Error('Missing image digest');
      state.deploymentDigest = evidence.deploymentDigest;
    }
    state.verdicts[gate] = {
      verdict: evidence.verdict,
      sha: evidence.sha,
      evidenceId: evidence.evidenceId,
    };
    state.inFlight = undefined;
    state.pendingReport = { gate, key, evidence };
    this.save(state);
    await this.ports.report(state, gate, evidence);
    state.pendingReport = undefined;
    await this.finish(state, gate, evidence);
  }
  private async finish(
    state: TaskState,
    gate: Gate,
    evidence: Evidence,
  ): Promise<void> {
    if (evidence.verdict === 'BLOCKED') {
      this.transition(state, 'BLOCKED', gate, evidence);
      return;
    }
    if (evidence.verdict === 'FAIL') {
      if (gate === 'POST_MERGE')
        this.transition(state, 'BLOCKED', gate, evidence);
      else this.rework(state, evidence);
      return;
    }
    if (
      gate === 'LAB_E2E' &&
      (await this.ports.developmentSha()) !== state.baseSha
    ) {
      this.rework(state, {
        verdict: 'FAIL',
        sha: state.headSha!,
        evidenceId: 'development-changed',
        defectCode: 'BASE_DRIFT',
      });
      return;
    }
    this.transition(state, next[gate]!, gate, evidence);
  }
  private rework(state: TaskState, evidence: Evidence): void {
    state.reworks++;
    if (state.reworks > state.maxReworks) {
      this.transition(state, 'BLOCKED', 'orchestrator', {
        ...evidence,
        defectCode: 'REWORK_EXHAUSTED',
      });
      return;
    }
    state.attempt++;
    state.candidateSha = undefined;
    state.deploymentDigest = undefined;
    state.verdicts = {};
    this.transition(state, 'REWORK', 'orchestrator', evidence);
  }
  private async ownerMerged(
    state: TaskState,
    verify: () => Promise<string>,
  ): Promise<void> {
    if (state.phase !== 'READY_FOR_OWNER_REVIEW')
      throw new Error('No verified Owner merge');
    const mergedSha = await verify();
    if (!isSha(mergedSha) || mergedSha !== (await this.ports.developmentSha()))
      throw new Error('Owner merge is not current development');
    this.transition(state, 'OWNER_MERGED', 'verified-github-owner');
    this.transition(state, 'POST_MERGE_VERIFY', 'orchestrator');
  }
}
