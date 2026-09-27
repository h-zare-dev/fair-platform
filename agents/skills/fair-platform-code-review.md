# Skill — Fair Platform Code Review

Apply this skill when reviewing a Fair Platform PR.

## Review lens
Check correctness before style:
- approved task compliance
- module and dependency boundaries
- idempotency and duplicate handling
- transaction boundaries and rollback behavior
- concurrency/race safety
- source timestamps vs receipt timestamps
- TypeORM query/locking correctness
- security and secret redaction
- immutable/auditable state requirements
- failure recovery and retry behavior
- test quality and missing regression coverage

Classify findings P0/P1/P2 using `agents/review.md`. Do not approve because CI is green if the implementation violates domain or architecture rules.
