# Skill — Feature Lifecycle Control

Use this skill when implementing, reviewing, QA-testing, or fixing a Fair Platform feature.

## Objective
Keep the entire feature lifecycle on one feature branch and one Draft PR until implementation, review, QA, CI, and human approval are complete.

## Procedure
1. Work only on the assigned feature branch created from `development`.
2. Use the existing Draft PR to `development` as the collaboration and status surface.
3. Never merge after the first implementation pass.
4. Implementation fixes Review and QA findings on the same feature branch.
5. Review repeats until `REVIEW_STATUS: PASS`.
6. QA repeats until `QA_STATUS: PASS`.
7. Production-code changes after a PASS invalidate that PASS when they affect the reviewed/tested behavior.
8. Require CI green after the final changes.
9. Require explicit human approval before marking Ready or merging.
10. After merge to `development`, operational/integration testing is separate from the feature-agent cycle; promotion to `main` uses a separate PR.

## Required status lines

- `IMPLEMENTATION_STATUS: READY_FOR_REVIEW | BLOCKED`
- `REVIEW_STATUS: PASS | FAIL | BLOCKED`
- `QA_STATUS: PASS | FAIL | BLOCKED`

Do not infer a PASS from silence, a successful commit, or green CI. Only the responsible agent can post its explicit PASS status.
