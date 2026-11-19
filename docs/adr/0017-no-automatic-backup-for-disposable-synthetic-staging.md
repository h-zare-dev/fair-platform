# ADR 0017 — Owner removal of automated backup and restore from synthetic Staging

**Decision:** Owner-directed, 2026-11-18; implemented after Owner merge PR #76 (`74a1cf8`). Supersedes the backup/restore parts of ADR 0016 **only** for the existing `panel.fairisfair.ir` synthetic-only FP-003B staging VPS. Other security and release controls remain unchanged. **Synthetic `pnpm test:backup` in full PR/CI verification is not a VPS backup** and remains a separate test requirement. See [current status](../CURRENT_STATE_AND_POLICY_2026-11-19.md).

## Decision and accepted risk

The Owner explicitly refuses backups and restores in the Staging deployment path. Once this change is merged by the human Owner to protected `development`, the automatic staging installer disables the existing `fair-staging-backup.timer` and switches the root-only activation gate to `staging-no-backup-v1`. New activations do not create a backup identity, backup environment or restore evidence. Every subsequent release requires this exact policy marker, and **neither runs a database backup nor checks restore evidence**. No backup image is pulled and no backup/restore tool is uploaded by the post-merge delivery workflow.

There is **no automatic periodic staging backup**, no pre-migration snapshot, no recovery drill, and no automated PostgreSQL restoration. Losing the VPS/volume or running a harmful forward-only migration can permanently destroy all staging data, even if the application containers can be rolled back. This is an intentional, high-impact exception because the database contains **synthetic test data only**. Never carry this policy to production, real user accounts, financial transactions, Pasarguard or live billing.

Previously produced archives, backup encryption keys, and restore evidence are **left intact but unused**, to avoid irreversible deletion. This change does not implement archive cleanup, alter other services, revoke credentials or change existing database volumes. The root-owned backup timer/service units may remain installed but the timer is disabled and the service must be inactive. If a backup is running, activation fails closed rather than killing its process.

## Unchanged controls

- GitHub protected `development`, actual human Owner merge, verified immutable image digests, source/provenance and branch ancestry, deployment serialization and pinned SSH host identity.
- Previously accepted `current.json`, root-owned configuration and activated schema, exact migrations and approved file hashes, explicit PostgreSQL image-transition approval, DB identity and mount checks, health/smoke checks and durable `release-state.json` journaling.
- The **app-only fallback** to previously accepted compatible API/Web/Caddy images on application startup failure. This is not a database restore.
- No automatic database DOWN migrations, PostgreSQL volume removal, automatic resolution of uncertain journals, production cutover or billing activation.

## Existing abandoned release incident

The Nov 18 candidate `5f02f07f4445a6fe5dc7365dc7a01dc514267b7a` failed in the former `backup` phase before migration, while the accepted manifest/high-water remained `06715bb74698074e5b8d536c563d8a1a9e791602`. Installing the new no-backup policy **does not clear that journal**; automatic deployment must remain blocked. After the human Owner merges this PR, a separate **manual-only**, Owner-gated workflow may check the exact SHA pair, accepted images and healthy services, unchanged PostgreSQL ID/image/mounts, migration names/file hashes, absence of one-shot containers and inactive old backup service/timer under the release lock. Only if all checks pass does it preserve the old journal verbatim in a mode-0600 file and mark the interrupted backup-phase journal resolved. It never touches the database, deploys a release or removes existing archives. The Owner must separately rerun or initiate a reviewed release afterwards.

This permission is limited to Staging. The Owner alone marks PRs ready, merges them, and dispatches the manual reconciliation workflow. Any mismatch remains an operator stop condition.
