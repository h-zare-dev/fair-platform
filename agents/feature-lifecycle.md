# Feature Lifecycle — Fair Platform

Every feature is developed on a dedicated feature branch created from `development`.

## Branch flow

`main` -> `development` -> `feature/<task>`

A feature branch must not be merged into `development` until the full implementation/review/QA cycle is complete.

## Required lifecycle

1. Create the feature branch from `development`.
2. Open a **Draft PR** from the feature branch to `development`.
3. Implementation Agent implements the approved task and pushes commits to the same feature branch.
4. CI runs on every relevant push/PR update.
5. Review Agent reviews the current PR diff and posts a review status.
6. If Review is not PASS, Implementation Agent fixes approved findings on the same feature branch and pushes more commits.
7. Review Agent re-reviews. Repeat until Review is PASS.
8. QA Agent performs adversarial verification against the current feature branch/PR.
9. If QA is not PASS, Implementation Agent fixes the failures on the same feature branch and pushes more commits.
10. QA Agent retests. Repeat until QA is PASS.
11. If a QA-driven fix materially changes production code, Review Agent performs a targeted re-review of the affected code. Review must return to PASS.
12. The PR stays Draft until all merge gates are satisfied.
13. When `REVIEW_STATUS=PASS`, `QA_STATUS=PASS`, and CI is green, the PR may be marked Ready for Review.
14. Human approval is required before merge.
15. Only then may the feature branch be merged into `development`.
16. After merge, perform integration/operational testing on `development`.
17. Promotion from `development` to `main` is a separate PR and requires its own final verification and human approval.

## Status protocol

Agents must post explicit machine-readable status lines in the Draft PR conversation.

Review Agent:

`REVIEW_STATUS: PASS | FAIL | BLOCKED`

QA Agent:

`QA_STATUS: PASS | FAIL | BLOCKED`

CI status is taken from GitHub Actions and must be green before merge.

A prior PASS is invalidated when later code changes affect the area that was reviewed or tested. Re-review/retest is required as appropriate.

## Merge gate

Merge to `development` is forbidden unless all are true:

- `REVIEW_STATUS: PASS`
- `QA_STATUS: PASS`
- required CI checks are green
- approved task Definition of Done is satisfied
- no unresolved P0/P1 findings
- no unresolved QA failures
- human approval is present

Agents must never merge a feature PR unless the human explicitly instructs them to do so.
