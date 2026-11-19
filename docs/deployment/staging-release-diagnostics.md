# Owner-only staging release diagnostics

> **Historical incident and diagnostic design (Nov 18–19), not current release
> instructions.** Some fields below mention old restore evidence/backups and
> now-reconciled journals. Current disposable Staging uses ADR 0017 **no
> backup/restore**, with a root-password bootstrap exception under ADR 0016.
> See [current status and incident chronology](../CURRENT_STATE_AND_POLICY_2026-11-19.md)
> and the updated [runbook](FP-003B-staging-runbook.md). Do not rerun old
> exact-SHA reconciliation actions or treat previous candidate diagnostics as
> current authorization.

**Owner request:** 2026-11-18. **Scope:** inspect the existing FP-003B synthetic-only
staging VPS through already configured protected GitHub Environment credentials,
without requiring the Owner to run repeated SSH commands.

## Why

After the Owner merged PR #73, post-merge CI #317 passed authorization, quality,
security, containers and image publishing, but `deploy` was blocked by
`UNRESOLVED_RELEASE_OPERATOR_REQUIRED`. The server reported a journal stuck
after `preflight` for `91177cf` (PR #72), while the accepted `current.json` and
`high-water.json` remained at `06715bb` (PR #71). API/Web/Caddy/PostgreSQL
remained healthy. A direct comparison of PostgreSQL mount arrays was `False`
but the **unordered** comparison was `True`: the two mounts, their source,
destination, access mode and type were unchanged.

## Execution and security boundary

After human review and **Owner-only merge**, a single diagnostic run starts
automatically because the reviewed workflow and script paths have changed.
Thereafter it can also be rerun explicitly via **Actions → Staging release
diagnostics (Owner only) → Run workflow**, with protected `development` selected
and confirmation `DIAGNOSE_STAGING`. Ordinary application pushes do not trigger
this workflow.

- Only the `h-zare-dev` actor, a protected `development` ref and the existing
  `staging-bootstrap` GitHub Environment can start the privileged job. Manual
  runs additionally require the exact confirmation string. Automatic runs
  require an Owner merge changing the *specific diagnostic code/workflow paths*.
  Pull requests receive no SSH credentials.
- The job first verifies the immutable, independently pinned Ed25519 host-key
  fingerprint. The temporary root password remains a masked Environment Secret
  and is not printed, committed, transmitted to any other host or given as a
  command argument.
- No user-supplied shell input is accepted. The runner pipes a reviewed Python
  diagnostic script to `python3 -` over pinned SSH. It does **not** install a
  script, replace a service, change any configuration, or clear a release
  journal. No secrets or Docker stderr are included in the output.
- The script takes the existing `deployment.lock` **read-only** and fails if a
  release holds it. It checks the journal/current/high-water relationship,
  orphan one-shot containers, running service image refs and health, PostgreSQL
  container ID/image ID, its mounts **as unordered identity records**, the
  config hash, recent restore evidence and approved migrations/hashes.
- The migration comparison runs `release-check.js` once in a disposable Docker
  `--rm --no-deps` container. That code uses `SELECT` against the migrations
  table, and `migrationsRun=false`; **no database migration is executed**.
- No public domain, production infrastructure, live billing, data transfer or
  off-server backup is involved. It serializes with ordinary staging deploys.

## Interpretation

The workflow prints one bounded JSON object with safe SHAs and booleans. Its
`operator_reconciliation_candidate=true` is **diagnostic evidence only**, not
permission to clear `release-state.json` or rerun a failed release. The Owner
must still reconcile the state under the deployment lock following the
[FP-003B staging runbook](FP-003B-staging-runbook.md). This workflow never
marks a journal resolved, changes `current.json`/`high-water.json`, removes an
orphan, restores or downgrades a database, or executes a new deployment.

## One-time Owner-controlled preflight reconciliation

The original Owner-authorized diagnostic run for PR #74 on 2026-11-18 reported
every check as `true`, including migrations/hashes, PostgreSQL mounts compared
unordered, current image refs, restore evidence, config hash and no orphan
containers. The abandoned PR #72 journal had candidate `91177cf...`, phase and
completed `preflight`, while the accepted current/high-water were both
`06715bb...`. The diagnostic itself did not change state.

The separate **Staging preflight reconciliation (Owner only)** workflow has
no push or PR trigger. After the human Owner reviews and merges its code, the
Owner must intentionally dispatch it on protected `development` with the exact
confirmation `RECONCILE_91177CF_TO_06715BB`. This is the Owner's express
authorization to modify the single named journal.

The reviewed script takes `deployment.lock` exclusively and **rechecks all
diagnostic conditions** at execution time. It additionally requires exact
full candidate and accepted SHAs, status `in-progress`, `phase=preflight`,
`completed=preflight`, the recorded previous manifest and high-water identity,
and matching accepted image refs in `current.env`. Any mismatch refuses the
operation without changing the journal. The actual preflight phase completed
before any backup, migration, database-image or startup phase was journaled.

Only after every condition passes, it preserves the **exact original**
`release-state.json` as a mode-0600, exclusive-create evidence file
`release-state.before-91177cf.json`, then atomically and durably sets that
existing journal's `status=resolved` with an explicit
`owner-verified-aborted-after-preflight` outcome and a verification timestamp.
It cannot be replayed or used for any other candidate. It does not change
`current.json`, `current.env`, `high-water.json`, images, containers, backups,
volumes or PostgreSQL; it does not start a deployment. Another release must
still pass normal GitHub Owner-merge, CI, ancestry, backup, migration and health
gates. Use the latest eligible post-merge deploy job, not the superseded PR #72
workflow.

Test coverage: `tests/release/test_diagnose_release.py` runs in the unprivileged
`quality` job and exercises mount reordering versus drift, orphan/image/config
drift, migration and hash mismatches, stale restore evidence, and secret-free
output.
