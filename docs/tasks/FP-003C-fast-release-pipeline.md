# FP-003C — Fast Release Pipeline (synthetic Staging)

**Status:** Owner **merged phase-one implementation PR #78 (`768254b`)** on
2026-11-19. The remaining proposal language below describes its reviewed
implementation contract, not the current Draft PR state. The phase-one
fast path applies to ordinary protected-`development` Staging releases; the
warm-cache 3–5-minute target needs real measurement. **Synthetic backup/restore
tests remain in full PR/main/manual CI, not on the Staging VPS** (ADR 0017).

## Problem and evidence

The Owner wants one predictable action: review/merge a green PR, then have
Staging publish automatically without SSH commands or a manual sequence of
reconciliation workflows. Actual post-merge CI #327 (`44439098908`) spent
15m23s in `containers`, of which 11m19s was the synthetic acceptance step.
That step installed `age` and `rclone` through apt; the package retrieval alone
took roughly six minutes. `security` took 24 seconds; removing security checks
would not fix the latency. The final deployment then failed during the app
rollout and safely restored the previous accepted images, but exposed only a
generic app failure. Read-only diagnostics run `44443406584` confirmed all
accepted services and database checks green after rollback.

## Contract

1. Human Owner alone marks a PR Ready and merges it. Required PR checks must
   include full quality, security, browser acceptance and synthetic Docker
   release/backup exercises. The protected branch and Owner merge verification
   remain mandatory.
2. A new merge to protected `development` runs quick quality/security,
   builds immutable images with per-service BuildKit cache scopes, scans all
   image types, generates SBOMs, validates Compose/Caddy, verifies the human
   Owner's merge, publishes exact digests, and deploys to Staging automatically.
   It does **not** reinstall Playwright or the `age`/`rclone` test dependencies
   and repeat the full synthetic Browser/Backup/Restore suite after the merge.
   `main`, PRs and explicit manual full-CI triggers retain the comprehensive
   tests. The existing GitHub status-check job names are unchanged.
3. Deployment keeps existing image provenance, pinned host key, exclusive
   lock, exact DB identity/volume checks, approved migration baseline, HTTPS,
   Owner auth, release-order proof and health/smoke gates. Real PostgreSQL
   state or financial credentials are never sent to Actions logs. No staging
   backup/restore is reintroduced. No production deployment is authorized.
4. If `startup`, public HTTPS `health` or synthetic `smoke` fails, the existing
   app-only rollback must finish before the journal resolves. CI should
   distinguish the failed phase with a fixed code; read-only diagnostics may
   expose the same bounded phase, never underlying Docker/SQL stderr.
5. An unresolved migration, database drift, incomplete rollback, branch
   supersession or orphan operation must still fail closed and require Owner
   investigation. The pipeline never pretends an unavailable application is
   healthy.

## Delivery stages

- **FP-003C Phase 1 (this PR):** PR-full vs development-fast CI, isolated
  Docker cache scopes, safe rollback-phase diagnostics, regression tests, and
  documented baseline/target. Do not bypass the failing runtime health check.
- **FP-003C Phase 2 (separate reviewed change):** optional changed-service
  image reuse and same-SHA retry *only if* complete immutable provenance,
  unchanged accepted services, a no-op migration proof, and an app-only
  rollback can be independently verified. Until proved, the existing
  anti-replay/high-water safety gate remains unchanged. Do not build a generic
  override that can replay database changes or roll back financial state.

## Acceptance and measurements

- PR still runs the complete acceptance and backup drill; protected merge
  still waits for Quality, Security, Containers and Owner authorization.
- Fast development post-merge skips only the large duplicated synthetic suite;
  full image security/Compose validation remains and the app gets the same
  staging health/smoke check before acceptance.
- Startup, health, smoke and rollback failures are regression-tested, and the
  original accepted manifest/database remain intact on app rollback.
- Target **3–5 minutes** from approved merge to successful ordinary Staging
  deployment after a warm build cache. This is an engineering *target*, not a
  verified SLA. Record timings across at least five healthy releases before
  claiming success. New migrations and cold-cache builds can take longer.
- The current Persian dashboard is **not** claimed deployed by this change.
  Its underlying runtime failure still needs evidence-based remediation.
