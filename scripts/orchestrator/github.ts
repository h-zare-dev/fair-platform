import { execFileSync } from 'node:child_process';
import { isSha, newTask, type TaskState } from './state.js';

const repo = 'h-zare-dev/fair-platform';
type Issue = {
  number: number;
  state: string;
  labels: { name: string }[];
  body: string;
  user: { login: string };
  pull_request?: unknown;
};
type Comment = { user: { login: string }; body: string; html_url: string };
function allComments(api: GitHubTransport, issue: number): Comment[] {
  const comments: Comment[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = api.get(
      `/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`,
    ) as Comment[];
    if (!Array.isArray(batch))
      throw new Error('Invalid GitHub comments response');
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error('Too many comments to verify idempotency');
}
export interface GitHubTransport {
  get(path: string): unknown;
  post(path: string, body: object): unknown;
  patch?(path: string, body: object): unknown;
}
export class GhTransport implements GitHubTransport {
  constructor(
    private readonly token: string,
    private readonly executable: string,
  ) {
    if (!token || !executable.startsWith('/'))
      throw new Error('GitHub credential or CLI unavailable');
  }
  get(path: string): unknown {
    return JSON.parse(
      execFileSync(this.executable, ['api', path], {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2_000_000,
        env: {
          PATH: '/usr/bin:/bin:/home/hossein/.local/bin',
          HOME: process.env.HOME ?? '',
          GH_TOKEN: this.token,
        },
      }),
    );
  }
  post(path: string, body: object): unknown {
    return JSON.parse(
      execFileSync(
        this.executable,
        ['api', path, '--method', 'POST', '--input', '-'],
        {
          input: JSON.stringify(body),
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 2_000_000,
          env: {
            PATH: '/usr/bin:/bin:/home/hossein/.local/bin',
            HOME: process.env.HOME ?? '',
            GH_TOKEN: this.token,
          },
        },
      ),
    );
  }
  patch(path: string, body: object): unknown {
    return JSON.parse(
      execFileSync(
        this.executable,
        ['api', path, '--method', 'PATCH', '--input', '-'],
        {
          input: JSON.stringify(body),
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 2_000_000,
          env: {
            PATH: '/usr/bin:/bin:/home/hossein/.local/bin',
            HOME: process.env.HOME ?? '',
            GH_TOKEN: this.token,
          },
        },
      ),
    );
  }
}

type Pull = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  merged_by?: { login: string };
  merge_commit_sha?: string;
  head: { sha: string };
  base: { ref: string };
};
export function ensureDraftPr(
  api: GitHubTransport,
  state: TaskState,
  branch: string,
): number {
  if (
    !/^agent\/[a-z0-9-]{1,80}$/.test(branch) ||
    !state.headSha ||
    !isSha(state.headSha)
  )
    throw new Error('Unsafe PR identity');
  const listed = api.get(
    `/repos/${repo}/pulls?state=open&head=h-zare-dev:${branch}&per_page=100`,
  ) as Pull[];
  let pr = listed.find((item) => item.base.ref === 'development');
  const body = `Tracks #${state.taskId}\nApproved spec: ${state.specPath} @ ${state.specSha}\nBase development SHA: ${state.baseSha}\nPR head SHA: ${state.headSha}\nCandidate SHA: ${state.candidateSha ?? 'PENDING'}\nOWNER_REVIEW_STATUS: BLOCKED\nOnly the human Owner may mark Ready or merge.`;
  if (!pr)
    pr = api.post(`/repos/${repo}/pulls`, {
      title: `agent: task #${state.taskId}`,
      head: branch,
      base: 'development',
      draft: true,
      body,
    }) as Pull;
  if (
    pr.state !== 'open' ||
    !pr.draft ||
    pr.base.ref !== 'development' ||
    pr.head.sha !== state.headSha
  )
    throw new Error('PR is not exact draft head');
  api.patch?.(`/repos/${repo}/pulls/${pr.number}`, { body });
  return pr.number;
}

export function verifyExactCi(
  api: GitHubTransport,
  sha: string,
  prNumber?: number,
): { url: string } {
  if (!isSha(sha) || !Number.isSafeInteger(prNumber) || prNumber! < 1)
    throw new Error('Exact PR identity is required for CI');
  const response = api.get(
    `/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
  ) as {
    total_count?: number;
    check_runs?: {
      id: number;
      head_sha: string;
      name: string;
      status: string;
      conclusion: string;
      html_url: string;
      app?: { slug?: string };
      pull_requests?: { number: number }[];
    }[];
  };
  if (
    !Array.isArray(response.check_runs) ||
    (response.total_count !== undefined &&
      response.total_count > response.check_runs.length)
  )
    throw new Error('Missing or truncated GitHub CI checks');

  // A check name is not proof of provenance: other apps or workflows can
  // publish checks with the same name. Authenticate the GitHub Actions job
  // and its parent workflow run, including repository, event and PR.
  const required = ['quality', 'security', 'containers'] as const;
  let evidenceUrl = '';
  let trustedRunId: number | undefined;
  for (const gate of required) {
    const candidates = response.check_runs.filter(
      (check) =>
        check.head_sha === sha &&
        check.name === gate &&
        check.app?.slug === 'github-actions' &&
        check.pull_requests?.some((pr) => pr.number === prNumber),
    );
    let verified = false;
    for (const check of candidates) {
      if (
        !Number.isSafeInteger(check.id) ||
        check.id < 1 ||
        check.status !== 'completed' ||
        check.conclusion !== 'success' ||
        !check.html_url
      )
        continue;
      const job = api.get(`/repos/${repo}/actions/jobs/${check.id}`) as {
        id?: number;
        run_id?: number;
        name?: string;
        status?: string;
        conclusion?: string;
      };
      if (
        job.id !== check.id ||
        job.name !== gate ||
        job.status !== 'completed' ||
        job.conclusion !== 'success' ||
        !Number.isSafeInteger(job.run_id) ||
        job.run_id! < 1
      )
        continue;
      const run = api.get(
        `/repos/${repo}/actions/runs/${job.run_id}`,
      ) as {
        path?: string;
        name?: string;
        event?: string;
        head_repository?: { full_name?: string };
        pull_requests?: { number: number }[];
      };
      if (
        run.path !== '.github/workflows/ci.yml' ||
        run.name !== 'CI' ||
        run.event !== 'pull_request' ||
        run.head_repository?.full_name !== repo ||
        !run.pull_requests?.some((pr) => pr.number === prNumber)
      )
        continue;
      if (trustedRunId !== undefined && trustedRunId !== job.run_id)
        throw new Error('Required CI gates are not from the same workflow run');
      trustedRunId = job.run_id;
      if (gate === 'quality') evidenceUrl = check.html_url;
      verified = true;
      break;
    }
    if (!verified)
      throw new Error(`Required exact-SHA ${gate} CI provenance is not green`);
  }
  return { url: evidenceUrl };
}

export function verifyOwnerMerge(
  api: GitHubTransport,
  prNumber: number,
  ownerLogin: string,
  expectedHead: string,
  developmentSha: string,
  approvedBaseSha: string,
): string {
  const pr = api.get(`/repos/${repo}/pulls/${prNumber}`) as Pull;
  if (
    !pr.merged ||
    pr.merged_by?.login !== ownerLogin ||
    pr.head.sha !== expectedHead ||
    !pr.merge_commit_sha ||
    pr.merge_commit_sha !== developmentSha ||
    pr.base.ref !== 'development'
  )
    throw new Error('Owner merge is not verified on current development');
  // The candidate was tested against a specific base. Accept only a real
  // two-parent merge of that exact base and reviewed feature head: a later
  // development advance or squash/rebase invalidates candidate evidence.
  const commit = api.get(
    `/repos/${repo}/git/commits/${pr.merge_commit_sha}`,
  ) as { parents?: { sha: string }[] };
  if (
    !isSha(approvedBaseSha) ||
    commit.parents?.length !== 2 ||
    commit.parents[0]?.sha !== approvedBaseSha ||
    commit.parents[1]?.sha !== expectedHead
  )
    throw new Error('Owner merge parents do not match verified candidate');
  return developmentSha;
}

export function approvedIssue(
  api: GitHubTransport,
  number: number,
  ownerLogin: string,
): TaskState {
  const issue = api.get(`/repos/${repo}/issues/${number}`) as Issue;
  if (
    issue.number !== number ||
    issue.state !== 'open' ||
    issue.pull_request ||
    !issue.labels?.some((label) => label.name === 'agent:approved') ||
    issue.labels.some((label) => label.name === 'agent:blocked')
  )
    throw new Error('Issue is not approved for execution');
  const spec =
    /^Approved spec: (docs\/tasks\/[\w-]+\.md) @ ([a-f0-9]{40})$/m.exec(
      issue.body,
    );
  const base = /^Base development SHA: ([a-f0-9]{40})$/m.exec(issue.body);
  if (!spec || !base) throw new Error('Issue lacks pinned spec/base');
  const comments = allComments(api, number);
  const approval = comments.find(
    (comment) =>
      comment.user.login === ownerLogin &&
      comment.body.trim() ===
        `OWNER_APPROVED_SPEC: ${spec[1]} @ ${spec[2]}\nBASE_DEVELOPMENT_SHA: ${base[1]}`,
  );
  if (!approval)
    throw new Error('Missing authenticated Owner approval of exact spec');
  const tree = api.get(`/repos/${repo}/git/trees/${base[1]}?recursive=1`) as {
    tree?: { path: string; sha: string }[];
  };
  if (!tree.tree?.some((item) => item.path === spec[1] && item.sha === spec[2]))
    throw new Error('Pinned spec is not on approved base');
  const blob = api.get(`/repos/${repo}/git/blobs/${spec[2]}`) as {
    sha?: string;
    encoding?: string;
    content?: string;
  };
  if (blob.sha !== spec[2] || blob.encoding !== 'base64' || !blob.content)
    throw new Error('Pinned spec blob unavailable');
  const content = Buffer.from(blob.content, 'base64').toString('utf8');
  if (!content.trim()) throw new Error('Approved spec is empty');
  if (!isSha(base[1]!)) throw new Error('Invalid base SHA');
  return newTask(number, spec[1]!, spec[2]!, base[1]!);
}

export function postVerdict(
  api: GitHubTransport,
  state: TaskState,
  gate: string,
  verdict: string,
  evidenceId: string,
  targetNumber = state.taskId,
): void {
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(evidenceId))
    throw new Error('Unsafe evidence ID');
  const sha = gate.startsWith('LAB') ? state.candidateSha : state.headSha;
  const body = `ISSUE: #${state.taskId}\nATTEMPT: ${state.attempt}\n${gate}_STATUS: ${verdict}\nHEAD_SHA: ${state.headSha ?? 'PENDING'}\nCANDIDATE_SHA: ${state.candidateSha ?? 'PENDING'}\nTESTED_SHA: ${sha ?? 'PENDING'}\nEVIDENCE_ID: ${evidenceId}`;
  const existing = allComments(api, targetNumber);
  if (existing.some((comment) => comment.body === body)) return;
  api.post(`/repos/${repo}/issues/${targetNumber}/comments`, { body });
}
