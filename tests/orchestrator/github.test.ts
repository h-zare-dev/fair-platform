import { describe, expect, it } from 'vitest';
import {
  approvedIssue,
  type GitHubTransport,
} from '../../scripts/orchestrator/github.js';

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
});
