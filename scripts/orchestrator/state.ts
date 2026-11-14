import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type Phase =
  | 'QUEUED'
  | 'IMPLEMENTING'
  | 'REVIEWING'
  | 'QA'
  | 'CI'
  | 'CANDIDATE_TESTING'
  | 'LAB_DEPLOYING'
  | 'LAB_E2E'
  | 'REWORK'
  | 'READY_FOR_OWNER_REVIEW'
  | 'OWNER_MERGED'
  | 'POST_MERGE_VERIFY'
  | 'DONE'
  | 'BLOCKED';
export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
export type Gate =
  | 'IMPLEMENTATION'
  | 'REVIEW'
  | 'QA'
  | 'CI'
  | 'CANDIDATE'
  | 'LAB_DEPLOY'
  | 'LAB_E2E'
  | 'POST_MERGE';
export type Transition = {
  at: string;
  attempt: number;
  phase: Phase;
  actor: string;
  headSha?: string | undefined;
  candidateSha?: string | undefined;
  evidenceId?: string | undefined;
  errorCode?: string | undefined;
};
export type TaskState = {
  taskId: number;
  specPath: string;
  specSha: string;
  baseSha: string;
  headSha?: string | undefined;
  candidateSha?: string | undefined;
  deploymentDigest?: string | undefined;
  phase: Phase;
  attempt: number;
  reworks: number;
  maxReworks: number;
  verdicts: Partial<
    Record<Gate, { verdict: Verdict; sha: string; evidenceId: string }>
  >;
  transitions: Transition[];
};

export function newTask(
  taskId: number,
  specPath: string,
  specSha: string,
  baseSha: string,
  maxReworks = 3,
): TaskState {
  if (
    !Number.isSafeInteger(taskId) ||
    taskId < 1 ||
    !/^docs\/tasks\/[\w-]+\.md$/.test(specPath) ||
    ![specSha, baseSha].every(isSha)
  )
    throw new Error('Invalid approved task identity');
  return {
    taskId,
    specPath,
    specSha,
    baseSha,
    phase: 'QUEUED',
    attempt: 1,
    reworks: 0,
    maxReworks,
    verdicts: {},
    transitions: [],
  };
}
export const isSha = (value: string): boolean => /^[a-f0-9]{40}$/.test(value);

export class StateStore {
  constructor(readonly path: string) {}
  load(): TaskState | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as TaskState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(state: TaskState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    const file = openSync(temp, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock: number;
    try {
      lock = openSync(`${this.path}.lock`, 'wx', 0o600);
    } catch {
      throw new Error(
        'Another orchestrator holds the task lock; inspect before recovery',
      );
    }
    try {
      return await fn();
    } finally {
      closeSync(lock);
      unlinkSync(`${this.path}.lock`);
    }
  }
}
