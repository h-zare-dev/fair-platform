# PILOT-001 — First automatic agent chain (isolated, non-production)

## Purpose

Prove that a single supervised Fair Platform Orchestrator invocation can autonomously
perform Implementation (Sol Low) → independent Review (Sol Low) → independent QA
(Luna Low), saving exact-SHA gate evidence and producing a **Draft** PR for a new,
small, bounded task. This issue does not authorize Lab, deployment, production
access, production data, or Owner-only merge actions.

## Implementation scope

Create a tiny, dependency-free TypeScript module
`scripts/pilot/phase-label.ts` that exports
`formatPilotPhase(value: string): string`. It must return these exact display
labels for exact, case-sensitive values:

| Input | Output |
| --- | --- |
| `QUEUED` | `Queued` |
| `IMPLEMENTING` | `Implementing` |
| `REVIEWING` | `Reviewing` |
| `QA` | `Quality assurance` |
| `BLOCKED` | `Blocked` |
| Any other input, including an empty string | `Unknown` |

Add focused Vitest coverage in
`tests/unit/pilot-phase-label.test.ts` for all accepted values,
unknown values, case sensitivity, and empty input. No new dependencies,
side effects, filesystem access, network calls, or environment variables.

## Verification

- The implementation must commit the work to its isolated branch.
- Independent Review and QA must inspect the **same** immutable HEAD SHA.
- QA runs the focused unit tests plus any relevant safe checks.
- A failing gate triggers bounded rework and new Review/QA on a new SHA.
- A passing QA is **not** authorization to merge or deploy.
- Pilot must persist its final **BLOCKED** state before candidate creation,
  Lab, E2E, or post-merge gates regardless of other CI outcomes.
- GitHub PR must remain Draft; the human Owner alone can decide on merge.

## Explicitly out of scope

No production code edits, accounting changes, migrations, financial behavior,
server SSH, real PasarGuard data, credentials, releases, or changes to the
automated CI security policy. If scope becomes ambiguous, block and report.
