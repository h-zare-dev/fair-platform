# Fair Platform — Canonical Feature Roadmap

**Updated:** 2026-10-13. **Branch of record:** `development`. **Status:** Owner-directed feature order; NOT blanket implementation, deployment or merge authorization.

This is the **canonical feature sequencing and status index**. Financial semantics remain governed by [Domain Rules](DOMAIN_RULES.md); architecture, security, testing and ADRs govern their respective domains. Only an **explicitly Owner-approved detailed task specification** authorizes Implementation. Planned milestones and design drafts are not approved specifications. Historical task files retain their original wording; read this index for current status.

## Delivery sequence and status

| Step | Milestone | Current status | Boundary |
| --- | --- | --- | --- |
| 1 | **FP-001 — Pasarguard Webhook Ingestion** | Merged to `development` (PR #6) | Durable authenticated-ready inbox, normalization, retries/deduplication. Live upstream authentication/delivery remains gated |
| 2 | **FP-002 — Accounting Foundations** | Merged (PR #27) | Immutable **SHADOW** ledger and idempotent exceptions only; no classification/pricing/live charge |
| 3a | **FP-003A — Offline Historical Replay** | Merged (PR #31); Owner-held private 1/7/30-day acceptance completed | Disposable PostgreSQL 17, real sanitized input locally; not live financial/HTTP verification |
| Correction | **FP-001B — Nullable Actor** | Merged (PR #32); Owner-held 30-day regression accepted | `by.id=null` no longer loses otherwise valid events; no accounting posting |
| Infrastructure | **CI after development merges** | Merged (PR #33) | GitHub `quality` on PR, pushes to `development`/`main`, manual dispatch |
| **NEXT** | **FP-003B — Public HTTPS Owner Dashboard + Staging CI/CD** | **Detailed spec proposed; Owner approval pending; NOT implemented** | Production-like dedicated public staging at `panel.fairisfair.ir`, Owner-only login/CLI, safe synthetic operations, Docker/Caddy/PostgreSQL, automatic post-merge staging deploy. No live billing/webhook |
| Next | **FP-004 — Pricing Engine** | Planned; detailed spec pending | Per-GiB, Fixed, Mixed, precedence/overrides, effective-dated rules, integer-Toman output |
| Next | **FP-005 — First Shadow Accounting: User Create** | Planned; detailed spec pending | User-create financial classification and **SHADOW** charges using FP-002 |
| Next | **FP-006 — Existing-User Baselines and Update Accounting** | Planned; detailed spec pending | Reliable initial state, update increases/decreases, state and ownership/transfer handling |
| Next | **FP-007 — Reset, Correlation, Renewal and Next Plan** | Planned; detailed spec pending | Manual/automatic reset, Reset+Update one renewal, actual Next Plan application and stable financial-operation identity |
| Later | Reports, Telegram/CSV, rollout and production activation | Not individually authorized here | Separate design, QA, shadow comparison, release gates |

**Do not skip FP-003B or relabel FP-007 as the next implementation.** A prior FP-007 *umbrella accounting-classifier draft* is a design discussion, not an approved replacement for the staged FP-004/005/006/007 roadmap. The proposed scopes beyond FP-003B still require detailed specifications and Owner review.

## FP-003A is not FP-003B

- **FP-003A is complete offline testing** with a disposable database that is removed after each run. It is not a persistent dashboard source and does not prove actual source HTTP/webhook delivery, pricing or monetary results.
- **FP-003B is NEXT and its detailed specification is awaiting Owner acceptance.** See [FP-003B implementation proposal](tasks/FP-003B-operational-dashboard.md), [ADR 0015](adr/0015-public-https-staging-and-controlled-delivery.md) and [staging runbook](deployment/FP-003B-staging-runbook.md). Owner chose public HTTPS on `panel.fairisfair.ir`, Cloudflare DNS-only, Dockerized Caddy with TLS-ALPN-01 on TCP/443, SSH key-only TCP/22, simple UFW, Owner CLI bootstrap and GitHub Actions → GHCR → automated staging deployment after human merge into `development`. The site remains Owner-authenticated, synthetic-data-only and **NO LIVE BILLING**; Owner must approve implementation and initial staging enablement separately.
- Do not connect FP-003B directly to Pasarguard/Pasarjew database, activate a live webhook, deploy **the later financial production environment**, or expose private historical replay datasets without separate explicit human approval and verified upstream security/delivery evidence. Public **staging** on its own VPS is not a production cutover. Dockerized staging deployment is automated only after the Owner approves one-time secure setup/go-live.

## Financial design decisions already established

- **Toman is integer (PostgreSQL BIGINT)**, never floating-point money. Canonical traffic is integer **bytes**; the FP-002 approved billing/display basis is **1 GiB = 1,073,741,824 bytes**, so quantities may be fractional GiB without rounding stored bytes. For a non-integral **final Toman** result, rounding policy remains **undecided** until the FP-004 Owner-approved specification. Do not choose silently.
- Real monthly/automatic usage resets are billable **without requiring a human Actor**; valid null Actor metadata must not discard an event. Actual Next Plan activation/reset is billable for the resulting package. Merely configuring a reset strategy or Next Plan is **not** billable.
- Correlated Reset + Update yields **one renewal charge** for the final package. Correlation is source-time-based, user-identity-aware, order-independent and Owner-configurable (default 120 seconds); do not infer Next Plan mapping/activation without evidence.
- Billing Admin owns the charge, not Actor Admin. Replayed duplicates create no extra financial effect; each distinct genuine monthly reset remains an independent billable operation.
- FP-002 supports SHADOW CHARGE recording but **does not** implement financial classification, pricing or LIVE posting. Initial baseline of existing users must not fabricate retroactive debt; a definitive source snapshot and uncertain-state rules require the future FP-006 task specification.
- Missing price, previous state or verified source semantics must not silently mean zero charge. See [Domain Rules](DOMAIN_RULES.md). Routine verified events should process automatically; exceptions are for genuine ambiguity, not blanket monthly-reset manual approvals.

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
- FP-003B public access architecture is selected, but its detailed specification remains Owner-review pending; actual staging host/IP, DNS/IPv6, SSH privileges, backup target and initial enablement remain operator prerequisites. FP-004 fractional-Toman final rounding; FP-006 baseline provenance; lateness/closure policy and FP-007 state-aware correlation still need task-level human decisions.
- P2 historical replay runtime scaling is deferred, not a reason to bypass financial or production gates.
- `main` intentionally has a separate promotion lifecycle and can lag `development`.

## Maintenance rule

Update milestone status only in an Owner-reviewed documentation PR referencing verified GitHub outcomes. Record financial decisions in `DOMAIN_RULES.md` and any relevant ADR rather than in informal prompts alone. Historical approved specifications are not rewritten as if they were current-state trackers. Agents may recommend roadmap changes but may **never** reorder milestones or authorize their own work.
