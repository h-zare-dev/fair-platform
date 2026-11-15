import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isSha } from './state.js';

type Input = {
  taskId: number;
  attempt: number;
  baseSha: string;
  headSha: string;
  idempotencyKey: string;
  sourceRepo: string;
  candidateWorktree: string;
  pnpmExecutable: string;
};
export function buildCandidate(input: Input): {
  verdict: 'PASS' | 'FAIL';
  sha: string;
  candidateSha?: string;
  evidenceId: string;
  defectCode?: string;
} {
  if (
    !isSha(input.baseSha) ||
    !isSha(input.headSha) ||
    !input.sourceRepo.startsWith('/') ||
    !input.candidateWorktree.startsWith('/') ||
    !input.pnpmExecutable.startsWith('/')
  )
    throw new Error('Invalid candidate input');
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', input.sourceRepo, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
  const evidenceId = `candidate-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`;
  let tree: string;
  try {
    tree = git(['merge-tree', '--write-tree', input.baseSha, input.headSha]);
  } catch {
    return {
      verdict: 'FAIL',
      sha: input.headSha,
      evidenceId,
      defectCode: 'MERGE_CONFLICT',
    };
  }
  if (!isSha(tree))
    return {
      verdict: 'FAIL',
      sha: input.headSha,
      evidenceId,
      defectCode: 'MERGE_CONFLICT',
    };
  const candidateSha = execFileSync(
    '/usr/bin/git',
    [
      '-C',
      input.sourceRepo,
      'commit-tree',
      tree,
      '-p',
      input.baseSha,
      '-p',
      input.headSha,
    ],
    {
      input: `Synthetic candidate #${input.taskId} attempt ${input.attempt}\n`,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fair Candidate',
        GIT_AUTHOR_EMAIL: 'candidate@invalid.local',
        GIT_COMMITTER_NAME: 'Fair Candidate',
        GIT_COMMITTER_EMAIL: 'candidate@invalid.local',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
    },
  ).trim();
  if (!isSha(candidateSha)) throw new Error('Candidate commit unavailable');
  if (!existsSync(input.candidateWorktree))
    git(['worktree', 'add', '--detach', input.candidateWorktree, candidateSha]);
  else {
    const status = execFileSync(
      '/usr/bin/git',
      ['-C', input.candidateWorktree, 'status', '--porcelain'],
      { encoding: 'utf8' },
    ).trim();
    if (status) throw new Error('Candidate worktree has uncommitted changes');
    execFileSync('/usr/bin/git', [
      '-C',
      input.candidateWorktree,
      'switch',
      '--detach',
      candidateSha,
    ]);
  }
  try {
    for (const args of [
      ['install', '--frozen-lockfile'],
      ['typecheck'],
      ['test'],
    ])
      execFileSync(
        '/usr/bin/prlimit',
        [
          '--cpu=600',
          '--as=6442450944',
          '--nofile=1024',
          '--',
          input.pnpmExecutable,
          ...args,
        ],
        { cwd: input.candidateWorktree, timeout: 600_000, maxBuffer: 200_000 },
      );
    return { verdict: 'PASS', sha: input.headSha, candidateSha, evidenceId };
  } catch {
    return {
      verdict: 'FAIL',
      sha: input.headSha,
      evidenceId,
      defectCode: 'CANDIDATE_TEST_FAILURE',
    };
  }
}

if (process.argv[1]?.endsWith('/candidate.js')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += String(chunk);
    if (input.length > 64_000) process.exit(2);
  });
  process.stdin.on('end', () => {
    try {
      process.stdout.write(
        JSON.stringify(buildCandidate(JSON.parse(input) as Input)),
      );
    } catch (error) {
      process.stderr.write(`Candidate stopped: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  });
}
