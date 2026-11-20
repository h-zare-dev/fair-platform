# FP-004 first Staging release: one-time config/schema approval

**Status:** operator procedure prepared; **not executed on the VPS by this PR**.
Applies only to the existing disposable, synthetic-only Staging environment.
Never run against production or an environment holding live billing data.

## Observed failure and why ordinary retry is insufficient

- Owner merged FP-004 Phase A PR **#81** as `e482a48a...` on `development`.
- Post-merge CI **#342**, [run 44646494453](https://github.com/h-zare-dev/fair-platform/actions/runs/44646494453), passed Quality, Security, Containers, Owner merge authorization and Publish. The automatic Deploy stopped with `CONFIG_REQUIRES_OPERATOR_UPGRADE`, **before any new database migration or app restart**.
- The exact change is the `owner-api` Compose mapping `FAIR_TIME_ZONE: ${FAIR_TIME_ZONE:-Asia/Tehran}`. The accepted VPS config hash still describes the prior Compose file. Even after approving this mapping, the new `AtomicCatalog1791300000000` migration is not in the VPS-approved `compatible-migrations.json`, so the next attempt would stop at `MIGRATION_COMPATIBILITY_UNPROVEN`.
- This is intentional fail-closed behavior, but exposing the two gates sequentially created a poor release experience. **Rerunning CI without an operator-approved transition does not fix either gate.**

## Owner's one-time release sequence

1. Review and **personally merge** the separate PR containing this workflow and its tests. The assistant must not mark it Ready or merge it. Its automatic CI may still fail at Deploy because the VPS remains on the old approved config: this is expected until this one-time transition is complete. Verify that the PR merge's `publish` job succeeded and the four images are in GHCR. If other checks fail, stop and investigate.
2. Open [Staging FP-004 config and schema approval (Owner only)](https://github.com/h-zare-dev/fair-platform/actions/workflows/staging-fp004-operator-upgrade.yml), choose the protected **`development`** branch, press **Run workflow**, and type exactly `APPROVE_FP004_STAGING_UPGRADE`. This uses the existing Owner-only `staging-bootstrap` Environment and its pinned SSH host identity. There are no new secrets to configure.
3. Await the exact success code `STAGING_FP004_CONFIG_AND_MIGRATION_APPROVED`. The workflow validates the live accepted config and healthy PostgreSQL, latest protected-branch SHA, OCI candidate image provenance, old vs. new read-only migration proofs and unchanged prior migration hashes. It accepts **only** the exact single timezone line and **only** the additive `AtomicCatalog` migration. It changes root-owned Compose/config-hash/approved-migration metadata **under the existing deployment lock**. It does **not** run migrations, restart applications, switch the PostgreSQL image, alter volumes, restore backups or access production.
4. Open the **latest** post-merge `CI` run for that same protected tip and select **Re-run failed jobs** (the failed `deploy` job). Do not rerun old superseded runs or one-time bootstrap/reconciliation workflows. The normal pipeline then re-verifies ancestry, manifest, database image/volume identity, migration hashes, runs the additive migration, health and authenticated Staging smoke tests, and performs app-only rollback if later app checks fail.
5. Confirm the Deploy result `STAGING_RELEASE_OK` and `STAGING_SMOKE_OK`, then manually view the Persian dashboard and its FP-004 forms. A green Publish alone does not mean the app was deployed; a green approval workflow alone does not mean migration ran.

**If the approval workflow fails:** no manifest/config approval should have been committed on a normal validation failure. Inspect the Owner-only read-only diagnostics workflow and host journal before proceeding. Do not delete `release-state.json`, alter the accepted PostgreSQL image, manually edit migration hashes, or bypass the checks. The workflow intentionally refuses drift, unknown migrations, changed legacy migration file hashes, unresolved releases and an advanced branch tip. Escalate any partial filesystem-write failure for manual reconciliation.

## Steady-state fast release after this transition

Subsequent *feature-only* Owner merges on `development` continue via the existing automatic `CI` → Publish → Deploy path. **No manual timezone approval is needed again** unless the actual Compose/Caddy config changes. New migrations intentionally require another explicit, narrowly reviewed operator approval; they are not silently accepted just because a feature was merged. This retains the synthetic-only Staging security and schema protections without forcing repeated manual work for ordinary UI/API releases.

## Relevant boundaries

- `FAIR_TIME_ZONE` defaults to `Asia/Tehran` in Compose. This one-time approval does not change the server's OS timezone, nor does it set arbitrary new IANA timezone values; future timezone changes require the appropriate separately reviewed configuration transition.
- The present ADR 0017 deliberately allows no automatic backup/restore for this **disposable Staging only**. A failed new migration may still need manual operator attention. No production billing is enabled by this runbook.
- The new tool is not an unconditional generic config/migration approval mechanism: its byte-for-byte Compose allowlist and exact single migration addition prevent future schema changes from riding along unnoticed.
