import { describe, expect, it } from 'vitest';
import {
  approvedIssue,
  type GitHubTransport,
} from '../../scripts/orchestrator/github.js';

const sha = (digit: string): string => digit.repeat(40);

describe('pinned pilot spec authorization', () => {
  it('rejects a changed development base without a new Owner approval', () => {
    let approvedBase = sha('b');
    const spec = `docs/tasks/PILOT-001.md @ ${sha('a')}`;
    const comment = [
      `OWNER_APPROVED_SPEC: ${spec}`,
      `BASE_DEVELOPMENT_SHA: ${sha('b')}`,
      `PILOT_SPEC_COMMIT_SHA: ${sha('d')}`,
    ].join('\n');
    const api: GitHubTransport = {
      get(path) {
        if (path.endsWith('/issues/57'))
          return {
            number: 57,
            state: 'open',
            labels: [{ name: 'agent:approved' }],
            body: [
              `Approved spec: ${spec}`,
              `Base development SHA: ${approvedBase}`,
              `Pilot spec commit SHA: ${sha('d')}`,
            ].join('\n'),
          };
        if (path.includes('/comments'))
          return [{ user: { login: 'h-zare-dev' }, body: comment }];
        if (path.includes('/git/commits/')) return { tree: { sha: sha('f') } };
        if (path.includes('/git/trees/'))
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
  });
});
