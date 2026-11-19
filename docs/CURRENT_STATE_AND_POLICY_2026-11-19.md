# Fair Platform — current state, decisions and documentation reconciliation

**Snapshot:** 2026-11-19, based on `development` after Owner-merged PR #79
(`568c0f58ef4213ca1be4c3fbff1a63dea59fa84e`), existing workflow/ADR
source, PR #80, and the Owner's report that the Persian synthetic Staging
dashboard is now available. This is a **documentation-only status record**:
it does not independently attest the live VPS at every moment, authorize a
server change, or claim financial production activation.

## Read this first: implemented vs observed vs planned

| Area | Current evidence and correct interpretation |
| --- | --- |
| FP-003B public staging | Owner reports the Persian Owner-only dashboard reachable. Initial implementation, activation and repeated rollback/reconciliation attempts happened; the old "never deployed / PR #36 pending" status is obsolete. The exact current public host SHA/health still requires live verification and must not be inferred solely from a green PR. |
| FP-003C | Phase-one fast-release implementation merged as Owner PR #78 (`768254b`). Full PR/full-CI safety tests remain; ordinary protected-`development` post-merge fast path skips **duplicated synthetic browser/backup acceptance**, not security scans or deployment integrity. Warm-cache 3–5 minutes is a target, not independently achieved. |
| FP-004 | A pure TypeScript pricing quote engine, synthetic Owner configuration/API and UI exist in `development`; **this is not live financial charging**, group pricing or nightly settlement. The Owner-approved earlier rule-version UI is being revised by PR #80 plus the approved 2026-11-19 nightly/group design. |
| FP-005/006/007 | Create/baseline/update/reset financial classifiers and live financial posting are **not complete**; require separately approved milestone specs, robust testing and later human-controlled rollout. |
| Reports | Telegram bot, actual daily settlement/finalized reports, weekly/monthly delivery and CSV generation are still planned, not running implementations. `apps/worker` currently runs ingestion, not the nightly settlement/report scheduler. |
| Calendar/contracts/shared | Calendar, contracts and shared package boundaries exist, but their intended complete common services are not implemented. Planned Jalali reporting cannot be described as running merely because the architecture document names it. |
| Source integration | Existing Staging uses synthetic data; no production webhook billing route. A **read-only PasarGuard admin ID/username picker** is now an Owner-approved direction but its upstream API key/connection is not provisioned or activated by PR #80. |

## Staging-specific overrides: ADR 0015 → ADR 0016 → ADR 0017

1. **ADR 0015** is the **original October architecture** for dedicated public
   HTTPS Staging and key-only SSH/off-host disaster recovery. The public HTTPS,
   synthetic-only, Owner-auth, network separation, protected merge and fail-closed
   database/image gates remain relevant. Its claim of "not deployed" and its
   one-time operator checklist are historical, not current evidence.
2. **ADR 0016**, Owner-approved on November 18, **explicitly replaced only**
   the applicable Staging SSH/bootstrap and backup approach: existing root
   password stored in protected GitHub Environment, pinned SSH host key, and
   ephemeral restricted deployment keys. The root credential is **high
   privilege**, even though script/merge gates restrict its intended use.
   The document originally introduced **same-VPS encrypted backups**, explicitly
   not disaster recovery. Its separate SSH exception remains current.
3. **ADR 0017**, the later November 18 Owner decision, **supersedes ADR 0016's
   backup/restore provisions on this disposable synthetic VPS only**. Current
   staging deploys have **no automated database backup, periodic backup or
   restore drill** and no backup gate. An application-only image rollback is
   **not** a database restore. An incompatible migration still fails closed.
   Previously created archives/keys remain untouched and unused.

**Accepted loss exposure:** if Staging VPS, PostgreSQL volume or data is lost,
its synthetic Owner state and test records may be **unrecoverable**. This exception
**must never be inherited by real accounts, production, finance, or PasarGuard**.

**Separate CI distinction:** `.github/workflows/ci.yml` still installs `age`
and `rclone` and runs `pnpm test:backup` for the **full synthetic test suite**
(PR/main/manual full verification). These are isolated test drills, **not** an
actual Staging VPS backup or automatic restore. FP-003C's fast path skips this
duplicated integration suite after a protected Owner merge. Keeping this test
does not contradict ADR 0017; removing it would be a separate CI decision.

**SSH:** It is **not accurate** to claim current Staging is SSH key-only. The
protected bootstrap/release workflow uses an Owner-provisioned masked root SSH
password. A short-lived forced-command key serves release operations, with
verified host identity. No claim is made that global root/password login has
been disabled. This accepted Staging-only tradeoff requires continuing Owner
control and must be reviewed/hardened before any production-style reuse.

## Custom Caddy/PostgreSQL images: evidence vs approval

The checked-in CI builds and scans custom Caddy and PostgreSQL-helper images;
`docker/staging/compose.yml` requires immutable pinned images. Current Caddy
source uses **2.11.9** (`docker/Dockerfile.caddy`), not the **2.11.7** baseline
scanned in `docs/implementation/FP-003B-image-decision.md`. The latter is a
dated October comparison, not a claim about the current deployed image.

The **2026-10-14 Owner decision was recorded later** in
[PR #36's relayed Owner decision comment](https://github.com/h-zare-dev/fair-platform/pull/36#issuecomment-6168437966)
and [independent re-review](https://github.com/h-zare-dev/fair-platform/pull/36#issuecomment-6168662738).
It was **not** a comment personally posted by the Owner, but it is a traceable
human-decision relay; the old claim of no approval evidence overlooked these
links. The Owner's 2026-11-19 direction to close outstanding documentation
issues reconfirms the [current disposition](security/STAGING_IMAGE_AND_ADVISORY_DECISION_2026-11-19.md):
retain the minimal custom builds for **disposable synthetic Staging only**,
with unchanged scans, SBOMs, provenance and migration gates. This is not proof
that older vulnerabilities were independently fixed or that the precise
image running on the VPS has been verified.

## Temporary advisories: real exposure and expiry

| Advisory | Scope currently excepted | Expiry | Required follow-up |
| --- | --- | --- | --- |
| `CVE-2026-112366` (`picomatch@4.0.7`) | Source scanner, specific **production API image**, and `pnpm audit` advisory ignore; **not** Web/PostgreSQL images | **2026-12-02** for Trivy YAML | GitHub's GHSA was **withdrawn 2026-11-18**, but NVD still lists the CVE and no compatible fix is proven. Recheck upstream and scanner output; remove exceptions only when justified. The `pnpm-workspace.yaml` ignore does **not** expire automatically. |
| `CVE-2026-116587` (`go-jose/v3@3.0.5`) | Source and **Caddy** image only | **2026-12-15** for Trivy YAML | Find compatible fixed dependency, retest Caddy and remove temporary waivers. |

`picomatch` is **also present in the production API image** through TypeORM
→ tinyglobby, contrary to stale comments claiming development-only exposure.
No untrusted glob usage has been established, but unreachability is **not
proven**. A passing security job with these narrowly scoped exceptions is
**not proof the vulnerabilities were fixed**. No automatic CI expiry has been
implemented for the `pnpm audit.ignore` entry; this requires a tracked human
review before December 2. The historical PR #55 source comment on the Caddy
exception is not a current scope condition.

The [November 19 Owner-directed review](security/STAGING_IMAGE_AND_ADVISORY_DECISION_2026-11-19.md)
records verified upstream facts and the narrow synthetic-Staging risk
acceptance. **Neither dependency is declared technically fixed.** If no
compatible fix is available at the deadline, affected deployment remains
blocked unless the Owner explicitly reviews and renews that risk decision.

## Owner API writes, source isolation and agent safety

- FP-003B's **original read-only operational dashboard** scope expanded with
  synthetic Owner-authenticated **pricing configuration writes in FP-004**.
  These permitted synthetic writes are not charges, webhook ingestion or live
  financial mutation. The proposed PasarGuard admin directory is **read-only**
  from official API and still separately credential-gated.
- Sensitive raw webhook batches are encrypted by the ingestion code (AES-GCM)
  **and** protected by host/DB/secret-access controls; encryption is not a
  substitute for retention limits or operator secrecy. No real PasarGuard
  payloads may be imported into public synthetic Staging.
- The present global Owner login throttle is a shared budget (10 attempts/minute,
  including successes), so an attacker may temporarily exhaust it. No
  per-source-IP user attribution is claimed. Any redesign requires a separate
  test-backed security change; this docs-only PR does not silently weaken it.
- **Owner decision 2026-11-19: autonomous development agents and their queue
  are cancelled; no further unattended agent runs are authorized.** Historic
  agent code, worktrees and guides remain for audit, not as release gates.
  The repository cannot remotely attest that any laptop-local processes
  have stopped. If agents are ever reactivated, `danger-full-access`
  worktrees are **not** OS isolation; use a least-privileged account/VM with
  no production credentials before starting.
- Agent model identifiers in old pilot logs are **historical evidence**,
  not a mandated model roster. No active autonomous model routing is required
  while the Owner's agent program is cancelled.

## Owner-approved future accounting direction (NOT yet implemented)

The Owner approved the [nightly settlement and local group design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md)
on November 19: events stored immediately **without daytime financial
calculation**; local group memberships updated with a separate history; the
group at each local day's close prices all operations of that day; exact
`(GiB bytes, duration days)` matching for both templated/manual accounts;
unmatched operations held in exceptions; nightly settlement scheduled with
configurable time, IANA timezone and default 10-minute grace; each **admin/day**
finalized and sent independently while other days continue; weekly/monthly
aggregations wait for complete daily snapshots and never reprice history.

This **supersedes the target design** of a system default tariff, per-event
financial posting and a date/version form attached to package definitions.
The old FP-004 quote implementation and FP-002 immutable SHADOW ledger remain
as-is in `development` until the Owner approves per-milestone code tasks and
forward-only schema migrations. Historical approved specifications are retained
and explicitly marked as historical baselines rather than edited to falsely
claim that the replacement functionality already runs.

## Documentation limitations and next gates

- This record does not prove live DNS, endpoint uptime, running application SHA,
  SSH host policy or database state. Owner/release diagnostic evidence is the
  source for those facts; do not invent verification.
- No real Telegram implementation, final Jalali report scheduler, CSV/report
  delivery, completed financial classifier or verified real API integration
  exists in the present source tree. These are planned v1.0 milestones.
- A docs-only PR may align specifications and report known gaps; it **does
  not** authorize live-source secrets, host changes, waiver extension,
  implementation or merge. Each feature phase gets a separate implementation
  Draft PR with appropriate explicit Owner approval and tests. Only human
  Owner marks Ready and merges.
