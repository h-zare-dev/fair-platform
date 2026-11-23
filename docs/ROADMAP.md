# Fair Platform — Canonical Feature Roadmap

**Updated:** 2026-11-19 (PRs #78/#79 merged; Owner-approved nightly design and PR #80). **Branch of record:** `development`. **Status:** Owner-directed feature order; NOT blanket implementation, deployment or merge authorization. For the exact Staging-policy exceptions and observational evidence, see [current status](CURRENT_STATE_AND_POLICY_2026-11-19.md).

**2026-11-19 maintenance decision:** the Owner cancelled autonomous developer
agents. New milestones use developer/interactive-assistant implementation,
independent human review and test-backed CI; old agent pilot/queue docs remain
historical. The Owner also delegated [final synthetic-Staging OD-01 retention
and security-advisory disposition](security/STAGING_IMAGE_AND_ADVISORY_DECISION_2026-11-19.md);
unpatched dependencies still have strict deadlines and are not silently
considered remediated.

This is the **canonical feature sequencing and status index**. Financial semantics remain governed by [Domain Rules](DOMAIN_RULES.md); architecture, security, testing and ADRs govern their respective domains. Only an **explicitly Owner-approved detailed task specification** authorizes Implementation. Planned milestones and design drafts are not approved specifications. Historical task files retain their original wording; read this index for current status.

## Delivery sequence and status

| Step | Milestone | Current status | Boundary |
| --- | --- | --- | --- |
| 1 | **FP-001 — Pasarguard Webhook Ingestion** | Merged to `development` (PR #6) | Durable authenticated-ready inbox, normalization, retries/deduplication. Live upstream authentication/delivery remains gated |
| 2 | **FP-002 — Accounting Foundations** | Merged (PR #27) | Immutable **SHADOW** ledger and idempotent exceptions only; no classification/pricing/live charge |
| 3a | **FP-003A — Offline Historical Replay** | Merged (PR #31); Owner-held private 1/7/30-day acceptance completed | Disposable PostgreSQL 17, real sanitized input locally; not live financial/HTTP verification |
| Correction | **FP-001B — Nullable Actor** | Merged (PR #32); Owner-held 30-day regression accepted | `by.id=null` no longer loses otherwise valid events; no accounting posting |
| Infrastructure | **CI after development merges** | Merged (PR #33) | GitHub `quality` on PR, pushes to `development`/`main`, manual dispatch |
| Implemented | **FP-003B — Public HTTPS Owner Dashboard + Staging CI/CD** | **Owner approval 2026-10-14; synthetic staging activated per Owner evidence; latest running SHA not independently confirmed** | Separate `panel.fairisfair.ir` public Owner-only synthetic dashboard, no real webhook/billing. Root-password protected Staging SSH exception (ADR 0016); **no automatic staging backup** (ADR 0017) |
| Infrastructure | **FP-003C — Fast Release Pipeline** | **Phase 1 Owner-merged PR #78 (`768254b`)** | Keep full PR/explicit full CI safety tests, speed up protected `development` post-merge Staging delivery; no production or financial safety bypass; [task spec](tasks/FP-003C-fast-release-pipeline.md) |
| **NEXT** | **FP-004 — Pricing Engine / Owner UI revision** | **Synthetic quote engine + editor implemented on `development`; PR #80 Draft docs for revised Owner-approved group/package/date design** | Existing per-GiB/fixed/Mixed source-time engine is *not* the approved target for nightly billing; new atomic bytes+days packages, local groups, direct exceptions, date-only assignments, no system default, read-only admin directory. **Implementation not yet complete** |
| In progress | **FP-005 — First Shadow Accounting: User Create** | Owner authorized an existing-Staging **no-backup Shadow test** on 2026-11-20. Implementation in Draft PR #89; see [bounded scope](tasks/FP-005-SHADOW-INGESTION-AND-AMBIGUITIES-PROPOSAL.md) and [operator test procedure](tasks/FP-005-STAGING-SHADOW-TEST.md). Not yet deployed or accepted. | Authenticated second webhook, encrypted intake, immutable nightly user-create Shadow candidates and separate accounting ambiguities; FP-006/007 and reporting remain future work. |
| Next | **FP-006 — Existing-User Baselines and Update Accounting** | Planned; detailed spec pending | Reliable initial state, update increases/decreases, state and ownership/transfer handling |
| Next | **FP-007 — Reset, Correlation, Renewal and Next Plan** | Planned; detailed spec pending | Manual/automatic reset, Reset+Update one renewal, actual Next Plan application and stable financial-operation identity |
| Later | Reports, Telegram/CSV, rollout and production activation | Not individually authorized here | Separate design, QA, shadow comparison, release gates |

**Do not skip FP-004 redesign or relabel FP-007 as the next implementation.** The Owner-approved [nightly settlement design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md) spans later phases but does not implement or renumber FP-004/005/006/007. Each implementation phase needs its own exact approved task, tests, forward-only migrations and review.

## FP-003A is not FP-003B

- **FP-003A is complete offline testing** with a disposable database that is removed after each run. It is not a persistent dashboard source and does not prove actual source HTTP/webhook delivery, pricing or monetary results.
- **FP-003B is implemented and Owner-reported active** (not a financial classifier). See [FP-003B historical implementation](tasks/FP-003B-operational-dashboard.md), [ADR 0015](adr/0015-public-https-staging-and-controlled-delivery.md), the **later staging SSH/backup overrides ADR 0016/0017**, and [operational runbook](deployment/FP-003B-staging-runbook.md). The public synthetic dashboard/HTTPS and protected post-merge automation exist; the earlier "key-only/no deployment/backup prerequisite" descriptions have been superseded **for this disposable VPS only**. The site remains Owner-authenticated, synthetic-data-only and **NO LIVE BILLING**.
- Do not connect FP-003B directly to Pasarguard/Pasarjew database, activate a live webhook, deploy **the later financial production environment**, or expose private historical replay datasets without separate explicit human approval and verified upstream security/delivery evidence. The proposed admin ID/username directory uses only an authorized **read-only Pasarguard API**, not its DB, and requires separate secret activation. Public Staging is not a production cutover.

## Financial design decisions already established

- **Toman is integer (PostgreSQL BIGINT)**, never floating-point money. Canonical traffic is integer **bytes**; the FP-002 approved billing/display basis is **1 GiB = 1,073,741,824 bytes**, so quantities may be fractional GiB without rounding stored bytes. **FP-004 Owner decision (2026-11-18): CEIL the final fractional Toman once; never round traffic bytes or interim money.**
- Real monthly/automatic usage resets are billable **without requiring a human Actor**; valid null Actor metadata must not discard an event. Actual Next Plan activation/reset is billable for the resulting package. Merely configuring a reset strategy or Next Plan is **not** billable.
- Correlated Reset + Update yields **one renewal charge** for the final package. Correlation is source-time-based, user-identity-aware, order-independent and Owner-configurable (Owner-corrected 2026-11-23 default 600 seconds for the read-only replay); do not infer Next Plan mapping/activation without evidence. See the [approved cycle replay correction](tasks/FP-006-FP-007-10-MINUTE-CYCLE-REPLAY.md).
- Billing Admin owns the charge, not Actor Admin. Replayed duplicates create no extra financial effect; each distinct genuine monthly reset remains an independent billable operation.
- FP-002 supports SHADOW CHARGE recording but **does not** implement financial classification, pricing or LIVE posting. Initial baseline of existing users must not fabricate retroactive debt; a definitive source snapshot and uncertain-state rules require the future FP-006 task specification.
- Missing price, previous state or verified source semantics must not silently mean zero charge. See [Domain Rules](DOMAIN_RULES.md). Routine verified events should process automatically; exceptions are for genuine ambiguity, not blanket monthly-reset manual approvals.
- **New Owner-approved future policy (2026-11-19):** no financial calculation during the day; process verified operations only at a configurable nightly close with a default ~10-minute delay. The end-of-local-day Fair group prices the admin's entire date and is preserved in history even if processing/report delivery is late. An ambiguous admin/day alone is held while later daily reports are sent separately; weekly/monthly wait for all finalized daily rows. Store immutable daily results; no retroactive re-pricing. Admin/group assignment, exact `(bytes, duration_days)` packages and date-only assignment bounds are defined in the [nightly design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md) and **not implemented yet**.

## Mandatory work / PR gates

1. **Read this roadmap first**, then `AGENTS.md` and authoritative contracts. Do not start coding until the Owner has approved a detailed task spec for the **current milestone**. A design discussion alone does not authorize a feature.
2. Feature work occurs only on a dedicated feature branch based on current `development` with a Draft PR. Never modify `development`/`main` directly. PR creation on the Owner's instructions **does not** authorize merge.
3. The exact PR head must pass independent `REVIEW_STATUS: PASS`, `QA_STATUS: PASS`, required GitHub `quality`, DoD and any **separately Owner-authorized private verification** before release recommendation.
4. **Only the human Owner may change a PR from Draft to Ready or execute Merge.** Assistants/agents **never** perform either action, even after green gates or generic requests to "finish". The Owner personally reviews and merges.
5. GitHub Actions triggers: PRs targeting `development`/`main`; pushes after Owner merges into these branches; manual dispatch. Post-merge CI on the actual new `development` commit must pass before promotion.
6. Promotion from `development` to `main` is an independent Owner-controlled PR. After approved FP-003B staging activation, Owner-merged `development` commits **may deploy automatically to isolated public STAGING after CI**; this is not an automated merge, production deployment, live webhook enablement or financial activation.

## Evidence boundaries and unanswered design questions

- Verified Owner-held historical 1/7/30-day offline replay and nullable Actor regression demonstrate normalization integrity/reproducibility **only**. No private counters, identities, HMAC keys, cutoffs, manifests or artifact paths belong in this public repository.
- Deployed upstream webhook HTTP envelope/authentication, actual origin of missing Actors, and non-null Next Plan fields/activation behavior remain unverified. Source action labels alone do not determine financial semantics.
- FP-003B activation is Owner-reported, but current live image/SHA, SSH policy and host state must still be verified operationally rather than inferred from checked-in documentation. **Staging backup/restore is deliberately disabled**, and Staging's root-password bootstrap is an accepted risk; neither policy authorizes production. **FP-004 CEIL was decided**, not pending. FP-006 baseline provenance, proven source duration for exact package matching, late-after-final adjustment behavior and FP-007 correlation still need implementation-grade validation.
- P2 historical replay runtime scaling is deferred, not a reason to bypass financial or production gates.
- `main` intentionally has a separate promotion lifecycle and can lag `development`.

## Maintenance rule

Update milestone status only in an Owner-reviewed documentation PR referencing verified GitHub outcomes. Record financial decisions in `DOMAIN_RULES.md` and any relevant ADR rather than in informal prompts alone. Historical approved specifications are not rewritten as if they were current-state trackers. Agents may recommend roadmap changes but may **never** reorder milestones or authorize their own work.
