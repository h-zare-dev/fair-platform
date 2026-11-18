# Owner-only staging release diagnostics

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

After human review and **Owner-only merge**, open **Actions → Staging release
diagnostics (Owner only) → Run workflow**, select protected `development` and
enter `DIAGNOSE_STAGING`.

- Only the `h-zare-dev` actor, a protected `development` ref, the exact
  confirmation string and the existing `staging-bootstrap` GitHub Environment
  can start the privileged job. Pull requests receive no SSH credentials.
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

Test coverage: `tests/release/test_diagnose_release.py` runs in the unprivileged
`quality` job and exercises mount reordering versus drift, orphan/image/config
drift, migration and hash mismatches, stale restore evidence, and secret-free
output.
