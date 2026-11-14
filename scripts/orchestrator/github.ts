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
export interface GitHubTransport {
  get(path: string): unknown;
  post(path: string, body: object): unknown;
}
export class GhTransport implements GitHubTransport {
  get(path: string): unknown {
    return JSON.parse(
      execFileSync('gh', ['api', path], {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2_000_000,
      }),
    );
  }
  post(path: string, body: object): unknown {
    return JSON.parse(
      execFileSync('gh', ['api', path, '--method', 'POST', '--input', '-'], {
        input: JSON.stringify(body),
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2_000_000,
      }),
    );
  }
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
  const comments = api.get(
    `/repos/${repo}/issues/${number}/comments?per_page=100`,
  ) as Comment[];
  const approval = comments.find(
    (comment) =>
      comment.user.login === ownerLogin &&
      comment.body.trim() === `OWNER_APPROVED_SPEC: ${spec[1]} @ ${spec[2]}`,
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
): void {
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(evidenceId))
    throw new Error('Unsafe evidence ID');
  const sha = gate.startsWith('LAB') ? state.candidateSha : state.headSha;
  const body = `ISSUE: #${state.taskId}\nATTEMPT: ${state.attempt}\n${gate}_STATUS: ${verdict}\nHEAD_SHA: ${state.headSha ?? 'PENDING'}\nCANDIDATE_SHA: ${state.candidateSha ?? 'PENDING'}\nTESTED_SHA: ${sha ?? 'PENDING'}\nEVIDENCE_ID: ${evidenceId}`;
  const existing = api.get(
    `/repos/${repo}/issues/${state.taskId}/comments?per_page=100`,
  ) as Comment[];
  if (existing.some((comment) => comment.body === body)) return;
  api.post(`/repos/${repo}/issues/${state.taskId}/comments`, { body });
}
