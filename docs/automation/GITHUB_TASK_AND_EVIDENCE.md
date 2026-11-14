# GitHub Task and Agent Evidence Contract

**Status:** proposal for implementation and operator acceptance. [Issue #53](https://github.com/h-zare-dev/fair-platform/issues/53).

## Planning — single source of truth

Owner discusses the feature with ChatGPT. ChatGPT writes an **implementation-grade Markdown specification** using `docs/tasks/<TASK-ID>-<slug>.md` on a dedicated planning/docs branch and opens a GitHub Issue referencing the proposed spec. The Owner approves the exact spec revision/commit before execution. Public GitHub is NOT for customer records, HMAC keys, private manifests, tokens, infrastructure passwords or private historical metrics.

The Orchestrator starts only when **all** conditions are true:
1. Issue belongs to `h-zare-dev/fair-platform` and has the expected type/identifiers.
2. Spec path and pinned `spec_sha` resolve to approved content.
3. An **Owner-authenticated approval** is verified (do not trust the presence of a public label alone). Never treat arbitrary issue author/commenter text as commands.
4. Owner-approved GitHub label `agent:approved` is present and no `agent:blocked` label is present.
5. No other feature is active, and no pending post-merge verification blocks the queue.
6. The task does not require unapproved finance decisions, production credentials, extra privileges or a new integration destination.

Suggested labels (create via a separate governance change): `agent:planned`, `agent:approved`, `agent:running`, `agent:blocked`, `agent:owner-review`, `agent:done`. GitHub label mutability alone is **not** an authorization mechanism; verify authenticated actors and an immutable approved spec reference.

## Immutable evidence and comments

Every PR links the Issue and pinned specification SHA. Every agent posts a sanitized **structured verdict tied to the exact commit**. An agent can append a new verdict; it cannot rewrite historical failures to disguise them. Store large sensitive-unsafe logs **locally** with short-lived redacted extracts in GitHub; never upload full credentials or private webhook JSON. GitHub artifacts are not automatically private on a public repo.

Required metadata:
- Issue number, spec file SHA, approved base development SHA, latest head SHA.
- GitHub CI/check run URL and conclusion for this exact revision.
- Review: `REVIEW_STATUS: PASS|FAIL|BLOCKED`, severity/issue IDs with reasons.
- QA: `QA_STATUS: PASS|FAIL|BLOCKED`, unit/integration/E2E coverage and measured failures.
- Lab E2E: `LAB_E2E_STATUS: PASS|FAIL|BLOCKED`, tested merge candidate SHA, image digest, test VPS identity alias (not secrets), synthetic scenario summary, migration/rollback/recovery outcomes, timestamps and evidence IDs.
- Final: `OWNER_REVIEW_STATUS: READY|BLOCKED` plus unresolved findings and explicit limitations.
- After merge: new `development` commit SHA and `POST_MERGE_STATUS: PASS|FAIL|BLOCKED`.

A new push **invalidates** Review, QA and Lab PASS unless the exact tested source/tree/image identity can be proved unchanged under a documented policy; default: run all gates again. Do not post a green final status if any evidence belongs to another head/candidate.

### Minimum PR body template

```markdown
## Scope
Closes/Tracks: #<issue>
Approved spec: docs/tasks/<task>.md @ <spec-sha>
Base development SHA: <base-sha>
PR head SHA: <head-sha>
Tested merge-candidate SHA: <candidate-sha>
Lab image digest: <digest>

## Implementation
- Changed modules:
- Migrations:
- New/updated tests:
- Known limitations:

## Independent gates
| Gate | Verdict | SHA / Evidence |
| ---- | ------- | -------------- |
| CI | PENDING | |
| Review | PENDING | |
| QA | PENDING | |
| Lab Deploy/E2E | PENDING | |
| Candidate freshness | PENDING | |

## Findings and rework
- Attempt / defect ID / reporter / root cause / fixing SHA / retest IDs:

## Delivery
OWNER_REVIEW_STATUS: BLOCKED
Only the Owner may mark Ready or merge.
```

The Orchestrator maintains a compact dashboard comment (edited only by the automation identity) plus append-only per-attempt evidence comments, so ChatGPT and the Owner can see the complete history via the connected GitHub tools. Git commits are not a substitute for test evidence. Agents must report real commands/test suite versions and outcomes; never say deployed or verified when only planned.

## Status updates, notification and limits

Issue/PR is the authoritative report; Telegram is an optional notification mirror containing only status, issue/PR URL and non-sensitive failure codes. If Telegram is down, persist the event locally and reconcile when available. Deduplicate notifications by task/attempt/state. Owner's PR merge remains the final human gate; no unattended direct push to `development` or `main`.
