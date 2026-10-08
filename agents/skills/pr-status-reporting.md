# Skill — PR Status Reporting

Use the Draft PR conversation as the authoritative collaboration log for a feature.

## Implementation Agent
After each implementation/fix cycle, post a concise summary and one status line:

- `IMPLEMENTATION_STATUS: READY_FOR_REVIEW`
- `IMPLEMENTATION_STATUS: BLOCKED`

## Review Agent
After each review/re-review, post findings and exactly one status line:

- `REVIEW_STATUS: PASS`
- `REVIEW_STATUS: FAIL`
- `REVIEW_STATUS: BLOCKED`

## QA Agent
After each QA/retest cycle, post results and exactly one status line:

- `QA_STATUS: PASS`
- `QA_STATUS: FAIL`
- `QA_STATUS: BLOCKED`

## Rules
- Statuses apply only to the PR commit state that was evaluated.
- Later relevant code changes may invalidate an earlier PASS.
- Green CI does not imply Review PASS or QA PASS.
- Review PASS does not imply QA PASS.
- QA PASS does not authorize merge by itself.
- Human approval is always required for merge to `development`.
