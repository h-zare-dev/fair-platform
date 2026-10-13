# Skill — Verification Before Completion

Use this skill before claiming any Fair Platform task is complete.

## Checklist
- Run the task-required tests.
- Run repository `format:check`, `lint`, `typecheck`, `test`, and `build` unless the task explicitly narrows them.
- Run migration/integration/E2E checks required by the task.
- Confirm CI status when CI is available.
- Confirm no secrets or generated local artifacts are staged.
- Confirm changed documentation matches implemented behavior; label proposed FP-003B staging capabilities **PLANNED** until actually verified.
- For FP-003B, do not claim public TLS, Docker port closure, automated deployment, Owner bootstrap, off-host backup or rollback was tested until an Owner-authorized environment test establishes it.
- Report any skipped check explicitly with the reason.

Never replace evidence with assumptions. A task with required failing or unrun checks is not complete.
