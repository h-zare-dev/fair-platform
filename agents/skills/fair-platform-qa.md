# Skill — Fair Platform QA

Apply adversarial QA to an implemented Fair Platform feature.

## Core scenarios
Choose the scenarios relevant to the task:
- duplicate requests and duplicate logical events
- retries after partial failure
- worker/process restart
- concurrent workers or requests
- out-of-order events
- malformed parent/child payloads
- unknown event types
- database timeout/unavailability
- stale or delayed source timestamps
- missing required state
- sensitive payloads and log redaction

For Owner-approved FP-003B, also include public HTTPS TLS-ALPN on 443 with port 80 closed; key-only host SSH 22, UFW and no Docker-published internals; CLI singleton/recovery, session safety, GitHub protected-branch staging release/rollback, and off-host restore evidence. Do not access real hosts or secrets without Owner authorization, or report environment-only tests as PASS when never run.

Prefer deterministic automated reproduction. Report PASS/FAIL/BLOCKED per `agents/qa.md`. Never change business rules to make a failing test pass.
