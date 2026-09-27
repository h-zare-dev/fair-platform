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

Prefer deterministic automated reproduction. Report PASS/FAIL/BLOCKED per `agents/qa.md`. Never change business rules to make a failing test pass.
