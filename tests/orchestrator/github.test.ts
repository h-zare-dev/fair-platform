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
            body: `OWNER_APPROVED_SPEC: docs/tasks/ISSUE-53.md @ ${sha('a')}\nBASE_DEVELOPMENT_SHA: ${sha('b')}`,
            html_url: 'https://example.test',
          },
        ];
      if (path.includes('/git/commits/'))
        return { tree: { sha: sha('f') } };
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
  it('requires an exact Owner comment for an unmerged pilot spec commit', () => {
    let approvedBase = sha('b');
    const api: GitHubTransport = {
      get(path) {
        if (path.endsWith('/issues/57'))
          return {
            number: 57,
            state: 'open',
            labels: [{ name: 'agent:approved' }],
            body: `Approved spec: docs/tasks/PILOT-001.md @ ${sha('a')}\nBase development SHA: ${approvedBase}\nPilot spec commit SHA: ${sha('d')}`,
          };
        if (path.includes('/comments'))
          return [
            {
              user: { login: 'h-zare-dev' },
              body: `OWNER_APPROVED_SPEC: docs/tasks/PILOT-001.md @ ${sha('a')}\nBASE_DEVELOPMENT_SHA: ${sha('b')}\nPILOT_SPEC_COMMIT_SHA: ${sha('d')}`,
              html_url: 'https://example.test/approval',
            },
          ];
        if (path.includes('/git/commits/'))
          return { tree: { sha: sha('f') } };
        if (path.includes('/trees/'))
          return { tree: [{ path: 'docs/tasks/PILOT-001.md', sha: sha('a') }] };
        return {
          sha: sha('a'),
          encoding: 'base64',
          content: Buffer.from('approved pilot content').toString('base64'),
        };
      },
      post() {
        throw new Error('unexpected mutation');
      },
    };
    expect(approvedIssue(api, 57, 'h-zare-dev', true).baseSha).toBe(sha('b'));
    approvedBase = sha('c');
    expect(() => approvedIssue(api, 57, 'h-zare-dev', true)).toThrow(
      'Missing authenticated Owner approval',
    );
    expect(() => approvedIssue(api, 57, 'h-zare-dev')).toThrow(
      'Missing authenticated Owner approval',
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
      verifyOwnerMerge(api, 101, 'h-zare-dev', sha('c'), sha('e'), sha('b')),
    ).toThrow('not verified');
  });
  it('accepts checks only from the trusted CI workflow and Owner merge parents', () => {
    const api: GitHubTransport = {
      get(path) {
        if (path.includes('check-runs'))
          return {
            check_runs: ['quality', 'security', 'containers'].map(
              (name, index) => ({
                id: 201 + index,
                head_sha: sha('c'),
                name,
                status: 'completed',
                conclusion: 'success',
                html_url: `https://example.test/${name}`,
                app: { slug: 'github-actions' },
                pull_requests: [{ number: 101 }],
              }),
            ),
          };
        if (path.includes('/actions/jobs/')) {
          const id = Number(path.split('/').at(-1));
          return {
            id,
            run_id: 555,
            name: ['quality', 'security', 'containers'][id - 201],
            status: 'completed',
            conclusion: 'success',
          };
        }
        if (path.includes('/actions/runs/'))
          return {
            name: 'CI',
            path: '.github/workflows/ci.yml',
            event: 'pull_request',
            head_repository: { full_name: 'h-zare-dev/fair-platform' },
            pull_requests: [{ number: 101 }],
          };
        if (path.includes('/git/commits/'))
          return {
            parents: [{ sha: sha('b') }, { sha: sha('c') }],
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
      'https://example.test/quality',
    );
    expect(
      verifyOwnerMerge(api, 101, 'h-zare-dev', sha('c'), sha('e'), sha('b')),
    ).toBe(sha('e'));
    expect(() =>
      verifyOwnerMerge(api, 101, 'h-zare-dev', sha('c'), sha('e'), sha('d')),
    ).toThrow('merge parents');
  });

  it('blocks on a failed security scan or an unrelated check producer', () => {
    const checks = ['quality', 'security', 'containers'].map((name, i) => ({
      id: 201 + i,
      head_sha: sha('c'),
      name,
      status: 'completed',
      conclusion: 'success',
      html_url: `https://example.test/${name}`,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: 101 }],
    }));
    let runPath = '.github/workflows/ci.yml';
    const api: GitHubTransport = {
      get(path) {
        if (path.includes('check-runs')) return { check_runs: checks };
        if (path.includes('/actions/jobs/')) {
          const id = Number(path.split('/').at(-1));
          return {
            id,
            run_id: 555,
            name: ['quality', 'security', 'containers'][id - 201],
            status: 'completed',
            conclusion: 'success',
          };
        }
        return {
          name: 'CI',
          path: runPath,
          event: 'pull_request',
          head_repository: { full_name: 'h-zare-dev/fair-platform' },
          pull_requests: [{ number: 101 }],
        };
      },
      post: () => ({}),
    };
    expect(verifyExactCi(api, sha('c'), 101).url).toBe(
      'https://example.test/quality',
    );
    checks[1]!.conclusion = 'failure';
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'security CI provenance is not green',
    );
    checks[1]!.conclusion = 'success';
    checks[2]!.status = 'in_progress';
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'containers CI provenance is not green',
    );
    checks[2]!.status = 'completed';
    checks[2]!.head_sha = sha('d');
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'containers CI provenance is not green',
    );
    checks[2]!.head_sha = sha('c');
    checks[0]!.app.slug = 'untrusted-app';
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'quality CI provenance is not green',
    );
    checks[0]!.app.slug = 'github-actions';
    runPath = '.github/workflows/malicious.yml';
    expect(() => verifyExactCi(api, sha('c'), 101)).toThrow(
      'quality CI provenance is not green',
    );
  });

  it('rejects a mutated issue base unless the Owner reapproves that base', () => {
    let mutatedBase = sha('b');
    const api: GitHubTransport = {
      get(path) {
        if (path.endsWith('/issues/53'))
          return {
            number: 53,
            state: 'open',
            labels: [{ name: 'agent:approved' }],
            body: `Approved spec: docs/tasks/ISSUE-53.md @ ${sha('a')}\nBase development SHA: ${mutatedBase}`,
          };
        if (path.includes('/comments'))
          return [
            {
              user: { login: 'h-zare-dev' },
              body: `OWNER_APPROVED_SPEC: docs/tasks/ISSUE-53.md @ ${sha('a')}\nBASE_DEVELOPMENT_SHA: ${sha('b')}`,
              html_url: 'https://example.test',
            },
          ];
        if (path.includes('/git/commits/'))
        return { tree: { sha: sha('f') } };
      if (path.includes('/trees/'))
          return { tree: [{ path: 'docs/tasks/ISSUE-53.md', sha: sha('a') }] };
        return {
          sha: sha('a'),
          encoding: 'base64',
          content: Buffer.from('approved content').toString('base64'),
        };
      },
      post: () => ({}),
    };
    expect(approvedIssue(api, 53, 'h-zare-dev').baseSha).toBe(sha('b'));
    mutatedBase = sha('c');
    expect(() => approvedIssue(api, 53, 'h-zare-dev')).toThrow(
      'Missing authenticated Owner approval',
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
