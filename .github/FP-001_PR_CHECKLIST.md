# FP-001 Draft PR Status Checklist

This file documents the status protocol for the FP-001 Draft PR. The PR itself remains the live source of status updates.

## Required agent statuses

Implementation Agent posts one of:

- `IMPLEMENTATION_STATUS: READY_FOR_REVIEW`
- `IMPLEMENTATION_STATUS: BLOCKED`

Review Agent posts one of:

- `REVIEW_STATUS: PASS`
- `REVIEW_STATUS: FAIL`
- `REVIEW_STATUS: BLOCKED`

QA Agent posts one of:

- `QA_STATUS: PASS`
- `QA_STATUS: FAIL`
- `QA_STATUS: BLOCKED`

## Merge gate

The Draft PR must not be merged into `development` until:

- implementation is complete for the approved scope
- `REVIEW_STATUS: PASS`
- `QA_STATUS: PASS`
- required CI checks are green
- the FP-001 Definition of Done is satisfied
- human approval is given

Any later code change that materially affects reviewed or tested behavior can invalidate an earlier PASS and requires targeted re-review and/or QA retest.
