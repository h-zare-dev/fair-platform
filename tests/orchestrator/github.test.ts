import { describe, expect, it } from 'vitest';
import {
  approvedIssue,
  ensureDraftPr,
  verifyExactCi,
  verifyOwnerMerge,
  postVerdict,
  type GitHubTransport,
} from '../../scripts/orchestrator/github.js';
import { newTask } from '../../scripts/orchestrator/state.js';

const sha = (digit: string) => digit.repeat(40);
describe('GitHub approval gate', () => {
  const makeApi = (actor: string): GitHubTransport => ({
    get(path) {
      if (path.endsWith('/issues/53'))
        return {
          number: 53,
          state: 'open',
          labels: [{ name: 'agent:approved' }],
          body: `Approved spec: docs/tasks/ISSUE-53.md @ ${sha('a')}\nBase development SHA: ${sha('b')}`,
        };
      if (path.includes('/comments'))
        return [
          {
            user: { login: actor },
            body: `OWNER_APPROVED_SPEC: docs/tasks/ISSUE-53.md @ ${sha('a')}`,
            html_url: 'https://example.test',
          },
        ];
      if (path.includes('/trees/'))
        return { tree: [{ path: 'docs/tasks/ISSUE-53.md', sha: sha('a') }] };
      return {
        sha: sha('a'),
        encoding: 'base64',
        content: Buffer.from('approved content').toString('base64'),
      };
    },
    post() {
      throw new Error('unexpected mutation');
    },
  });
  it('requires authenticated Owner approval of the pinned spec', () => {
    expect(() =>
      approvedIssue(makeApi('other-user'), 53, 'h-zare-dev'),
    ).toThrow('Missing authenticated Owner approval');
    expect(approvedIssue(makeApi('h-zare-dev'), 53, 'h-zare-dev').specSha).toBe(
      sha('a'),
    );
  });
  it('creates only a Draft PR and reuses it on retry', () => {
    const state = newTask(57, 'docs/tasks/TASK-57.md', sha('a'), sha('b'));
    state.headSha = sha('c');
    let created = 0;
    const pr = {
      number: 101,
      state: 'open',
      draft: true,
      merged: false,
      head: { sha: sha('c') },
      base: { ref: 'development' },
    };
    const api: GitHubTransport = {
      get: () => (created ? [pr] : []),
      post: (_path, body) => {
        expect(body).toMatchObject({ draft: true, base: 'development' });
        created++;
        return pr;
      },
      patch: () => pr,
    };
    expect(ensureDraftPr(api, state, 'agent/57-aaaaaaaaaaaa')).toBe(101);
    expect(ensureDraftPr(api, state, 'agent/57-aaaaaaaaaaaa')).toBe(101);
    expect(created).toBe(1);
  });
  it('rejects stale CI and non-Owner merges', () => {
    const api: GitHubTransport = {
      get(path) {
        if (path.includes('check-runs'))
          return {
            check_runs: [
              {
                head_sha: sha('d'),
                name: 'quality',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://example.test/check',
                pull_requests: [{ number: 101 }],
              },
            ],
          };
        return {
          merged: true,
          merged_by: { login: 'other-user' },
          merge_commit_sha: sha('e'),
          head: { sha: sha('c') },
          base: { ref: 'development' },
        };
      },
      post: () => ({}),
    };
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow('not green');
    expect(() =>
      verifyOwnerMerge(api, 101, 'h-zare-dev', sha('c'), sha('e')),
    ).toThrow('not verified');
  });
  it('accepts only the exact successful PR check and Owner merge commit', () => {
    const api: GitHubTransport = {
      get(path) {
        if (path.includes('check-runs'))
          return {
            check_runs: [
              {
                head_sha: sha('c'),
                name: 'quality',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://example.test/check',
                pull_requests: [{ number: 101 }],
              },
              ...(['security', 'containers'] as const).map((name) => ({
                head_sha: sha('c'),
                name,
                status: 'completed',
                conclusion: 'success',
                html_url: `https://example.test/${name}`,
                pull_requests: [{ number: 101 }],
              })),
            ],
          };
        return {
          merged: true,
          merged_by: { login: 'h-zare-dev' },
          merge_commit_sha: sha('e'),
          head: { sha: sha('c') },
          base: { ref: 'development' },
        };
      },
      post: () => ({}),
    };
    expect(verifyExactCi(api, sha('c'), 101).url).toBe(
      'https://example.test/check',
    );
    expect(verifyOwnerMerge(api, 101, 'h-zare-dev', sha('c'), sha('e'))).toBe(
      sha('e'),
    );
  });
  it('blocks on a failed security audit or container image scan', () => {
    const green = (name: string) => ({
      head_sha: sha('c'),
      name,
      status: 'completed',
      conclusion: 'success',
      html_url: `https://example.test/${name}`,
      pull_requests: [{ number: 101 }],
    });
    const checks = [green('quality'), green('security'), green('containers')];
    const api: GitHubTransport = {
      get: () => ({ check_runs: checks }),
      post: () => ({}),
    };
    expect(verifyExactCi(api, sha('c'), 101).url).toBe(
      'https://example.test/quality',
    );
    checks[1] = { ...green('security'), conclusion: 'failure' };
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'security CI is not green',
    );
    checks[1] = green('security');
    checks[2] = { ...green('containers'), status: 'in_progress' };
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'containers CI is not green',
    );
    checks[2] = green('containers');
    checks[2] = { ...checks[2], head_sha: sha('d') };
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'containers CI is not green',
    );
  });

  it('does not repost the same verdict after a reporting restart', () => {
    const state = newTask(57, 'docs/tasks/TASK-57.md', sha('a'), sha('b'));
    state.headSha = sha('c');
    const comments: { body: string }[] = [];
    let posts = 0;
    const api: GitHubTransport = {
      get: () =>
        comments.map((item) => ({
          ...item,
          user: { login: 'agent' },
          html_url: 'https://example.test',
        })),
      post: (_path, body) => {
        comments.push(body as { body: string });
        posts++;
        return body;
      },
    };
    postVerdict(api, state, 'REVIEW', 'PASS', 'review-1');
    postVerdict(api, state, 'REVIEW', 'PASS', 'review-1');
    expect(posts).toBe(1);
  });
});
