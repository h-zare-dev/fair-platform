# Skill — Feature Lifecycle Control

Use this skill when implementing, reviewing, QA-testing, or fixing a Fair Platform feature.

## Objective
Keep the entire feature lifecycle on one feature branch and one Draft PR until implementation, review, QA, CI, and human approval are complete. Read `docs/ROADMAP.md` and the explicitly Owner-approved detailed task spec first; a draft FP-003B design/docs PR does not authorize implementation or initial staging deployment.

## Procedure
1. Work only on the assigned feature branch created from `development`.
2. Use the existing Draft PR to `development` as the collaboration and status surface.
3. Never merge after the first implementation pass.
4. Implementation fixes Review and QA findings on the same feature branch.
5. Review repeats until `REVIEW_STATUS: PASS`.
6. QA repeats until `QA_STATUS: PASS`.
7. Production-code changes after a PASS invalidate that PASS when they affect the reviewed/tested behavior.
8. Require CI green after the final changes.
9. **Never mark Ready or Merge yourself; only the human Owner** personally performs both actions, regardless of technical PASS or general instruction.
10. After Owner merge to `development`, verify the real post-merge CI. In a future Owner-authorized FP-003B staging environment, protected `development` merges may trigger automatic **staging-only** release; first activation and all production releases remain Owner-controlled. Promotion to `main` uses a separate Owner-only PR.

## Required status lines

- `IMPLEMENTATION_STATUS: READY_FOR_REVIEW | BLOCKED`
- `REVIEW_STATUS: PASS | FAIL | BLOCKED`
- `QA_STATUS: PASS | FAIL | BLOCKED`

Do not infer a PASS from silence, a successful commit, or green CI. Only the responsible agent can post its explicit PASS status.
