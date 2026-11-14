import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type Evidence, type Ports } from './engine.js';
import { approvedIssue, GhTransport, postVerdict } from './github.js';
import { loadModelRoutes } from './models.js';
import { isSha, StateStore, type Gate } from './state.js';

type Command = { executable: string; args: string[]; timeoutMs: number };
type Config = {
  issue: number;
  ownerLogin: string;
  stateFile: string;
  modelFile: string;
  labActivated: boolean;
  commands: Record<Gate, Command>;
};
const gates: Gate[] = [
  'IMPLEMENTATION',
  'REVIEW',
  'QA',
  'CI',
  'CANDIDATE',
  'LAB_DEPLOY',
  'LAB_E2E',
  'POST_MERGE',
];

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (
    config.issue < 1 ||
    !/^[a-zA-Z0-9-]+$/.test(config.ownerLogin) ||
    !config.stateFile.startsWith('/') ||
    !config.modelFile.startsWith('/')
  )
    throw new Error('Invalid runner configuration');
  loadModelRoutes(config.modelFile);
  for (const gate of gates) {
    const command = config.commands[gate];
    if (
      !command?.executable.startsWith('/') ||
      !Array.isArray(command.args) ||
      command.args.some((arg) => typeof arg !== 'string') ||
      command.timeoutMs < 1000 ||
      command.timeoutMs > 3_600_000
    )
      throw new Error(`Invalid ${gate} command`);
  }
  return config;
}

export function commandPorts(config: Config): Ports {
  const api = new GhTransport();
  return {
    reconcile(state) {
      const current = approvedIssue(api, state.taskId, config.ownerLogin);
      if (
        current.specSha !== state.specSha ||
        current.baseSha !== state.baseSha
      )
        throw new Error('Approved task changed after checkpoint');
      return Promise.resolve();
    },
    developmentSha() {
      const ref = api.get(
        '/repos/h-zare-dev/fair-platform/git/ref/heads/development',
      ) as { object?: { sha?: string } };
      const sha = ref.object?.sha;
      if (!sha || !isSha(sha)) throw new Error('Cannot verify development SHA');
      return Promise.resolve(sha);
    },
    run(gate, state) {
      if ((gate === 'LAB_DEPLOY' || gate === 'LAB_E2E') && !config.labActivated)
        throw new Error('Lab activation has not been approved');
      const command = config.commands[gate];
      const input = JSON.stringify({
        taskId: state.taskId,
        attempt: state.attempt,
        specPath: state.specPath,
        specSha: state.specSha,
        baseSha: state.baseSha,
        headSha: state.headSha,
        candidateSha: state.candidateSha,
        deploymentDigest: state.deploymentDigest,
        gate,
      });
      const output = execFileSync(command.executable, command.args, {
        input,
        encoding: 'utf8',
        timeout: command.timeoutMs,
        maxBuffer: 256_000,
        env: { ...process.env, FAIR_MODEL_CONFIG: config.modelFile },
      });
      const evidence = JSON.parse(output) as Evidence;
      if (
        !['PASS', 'FAIL', 'BLOCKED'].includes(evidence.verdict) ||
        !/^[a-zA-Z0-9_.:-]{1,120}$/.test(evidence.evidenceId)
      )
        throw new Error('Invalid gate evidence');
      return Promise.resolve(evidence);
    },
    report(state, gate, evidence) {
      postVerdict(api, state, gate, evidence.verdict, evidence.evidenceId);
      return Promise.resolve();
    },
  };
}

export async function runOnce(configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const store = new StateStore(config.stateFile);
  const api = new GhTransport();
  const approved = approvedIssue(api, config.issue, config.ownerLogin);
  const state = store.load() ?? approved;
  if (state.taskId !== approved.taskId || state.specSha !== approved.specSha)
    throw new Error('Active task differs from approved issue');
  // The lock covers one transition. Scheduler invokes this process repeatedly, serially.
  await store.withLock(() =>
    new Orchestrator(commandPorts(config), (value) => store.save(value)).step(
      state,
    ),
  );
}

if (process.argv[1]?.endsWith('/runner.js')) {
  const path =
    process.argv[2] ??
    join(homedir(), '.config/fair-platform/orchestrator.json');
  runOnce(path).catch((error) => {
    process.stderr.write(`Orchestrator stopped: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
