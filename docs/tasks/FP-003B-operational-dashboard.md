# FP-003B — Public HTTPS Staging Owner Dashboard and Automatic Delivery

**Status:** DRAFT IMPLEMENTATION SPECIFICATION — prepared for human Owner review, **not yet approved for Implementation or server changes**. This proposal supersedes the original *private-access design brief*, not the canonical financial/domain rules. See [ROADMAP](../ROADMAP.md), [ADR 0015](../adr/0015-public-https-staging-and-controlled-delivery.md), and [staging operations](../deployment/FP-003B-staging-runbook.md).

**Target:** one public-facing, production-like **STAGING** website at **https://panel.fairisfair.ir**, serving a single authenticated Owner from desktop and mobile. The UI/API operate on safe persistent synthetic Fair data; the service is **not** connected to production Pasarguard or Pasarjew and **does not post financial charges**. Staging delivery becomes automatic *after the Owner's one-time staging enablement* and after the Owner merges approved code to `development`.

## 1. Evidence, current code and explicit scope

Baseline as of 2026-10-13: `development` at `ff39bd7a08aa0569c9cb409f8e0642d80a22356e`. FP-001/001B normalize/inbox, FP-002 has SHADOW-only immutable ledger, FP-003A runs only in removable offline Testcontainers; none supplies a hosted Owner dashboard, live authentication or financial posting. `apps/web` is a placeholder. `apps/api/src/main.ts` **intentionally fails startup with NODE_ENV=production** because the real Pasarguard webhook authenticator is not verified.

FP-003B delivers:
- Real Next.js 16 Owner Login/Logout/Dashboard responsive on mobile and desktop, with accessible empty/loading/error states.
- A narrowly scoped NestJS 12/Fastify **Owner-only API mode** and Owner bootstrap/recovery CLI; avoid coupling to unverified webhook startup.
- Four precise operational metrics, paginated recent normalized events and safe ingestion issues, source/time filtering, and unambiguous STAGING / SYNTHETIC / SHADOW / NO LIVE BILLING labels.
- Persistent **isolated** PostgreSQL 17 for staging plus explicit synthetic demonstration dataset. Owner/auth sessions are the only application writes allowed in ordinary dashboard operation; read-only refers to ingestion/financial business data.
- Versioned Docker production images, a containerized Caddy HTTPS reverse proxy, reproducible Compose configuration, and GitHub-hosted Actions quality/security/build/publish and **automatic staging deploy on Owner-merged `development`**.
- Backup/restore verification, health/smoke checks, safe failure/rollback behaviors and an operational runbook.

Outside scope: Pasarguard/Pasarjew live endpoints, historical private replay imports, any live webhook receiver or production credential, pricing/classification/money calculations, billing or ledger writes, Telegram/CSV/reporting UI, multi-tenant accounts, general admin registration, public API documentation, GitHub merge automation, production cutover or `main` deployment. Do not rewrite FP-001/FP-002 historical migrations or relax their security guard.

## 2. Deployment architecture and data flow

```text
Laptop / Phone  --public HTTPS TCP/443--> Cloudflare DNS-only A/AAAA
                                    -> Caddy container (443/tcp ONLY)
                                    -> /api/v1/owner/* : NestJS/Fastify Owner API
                                    -> all other paths: Next.js Web
                                      Owner API -> staging PostgreSQL 17
                                      Auth -> Owner and session rows in the same Fair DB

GitHub: feature/* -> Draft PR -> Review PASS -> QA PASS -> CI PASS
       -> human Owner merge to development
       -> GitHub-hosted Actions (quality + security gates + build images)
       -> GHCR immutable image digests -> SSH TCP/22 -> staging deploy
       -> validate prerequisites -> migrate -> image pull/start -> health/smoke
       -> success or safe app-only rollback / BLOCKED
```

Domain: `panel.fairisfair.ir`. Cloudflare zone is **DNS-only (grey cloud)** for this hostname. Set only valid A/AAAA records for addresses that really reach Caddy over TCP/443; do not provision a broken AAAA address. No Cloudflare proxy or DNS-01 integration in FP-003B.

Single domain/origin: Caddy routes `/api/v1/owner/*` to Owner API and everything else to Next.js; secure cookie remains same-site. The Owner API process **must not** register the Pasarguard webhook controller. Either add a separate Owner API entrypoint or an explicitly mode-scoped module/bootstrapping path; pick the smallest maintainable arrangement consistent with modular monolith. Never remove the existing production fail-closed check in the webhook bootstrap or set `PASARGUARD_ALLOW_UNAUTHENTICATED_DEVELOPMENT=true` to run public staging.

Staging is a **real internet-facing deployment**, but **not** the eventual live Pasarguard/Pasarjew production deployment. Planned v1.0 production topology on the original Pasarguard VPS stays separately gated. Staging owns its own host, database, volumes, credentials and environment.

## 3. Edge, DNS, TLS and firewall — fixed Owner decisions

- Caddy runs inside Docker (official, pinned image). Only **TCP 443** is published to host/public network for Caddy; no TCP 80, no UDP 443/HTTP3. Enable HTTPS and TLS-ALPN-01; explicitly disable ACME HTTP-01 challenge and automatic HTTP→HTTPS redirect since TCP 80 stays closed. Ensure no other listener/binding opens port 80. Persist Caddy `/data` and `/config` for issuance/renewal.
- Caddy handles TLS termination, proper proxy headers and same-origin paths; trust forwarded headers **only** from the known reverse-proxy hop. Set conservative request body/timeouts, security headers, and avoid disclosing internal errors. Do not cache authenticated pages/API responses publicly; no CDN/proxy caching of sessions.
- Certificate preflight: public DNS must resolve to the correct reachable IPv4/IPv6; public CA must reach 443; CAA records (if present) must permit the issuer; ACME account contact email supplied as a secret-free operator setting. Test initial issuance and repeat renewal/restart with 80 still closed. Do not claim plain HTTP/80 redirects work.
- Host inbound UFW policy: allow **TCP/22** (SSH public-key auth) and **TCP/443**; deny other inbound; IPv6 policy must match. SSH password authentication and keyboard-interactive password login disabled **only after separately testing a new key-based session and provider rescue console**. The Owner chooses whether root SSH is permitted; a separate sudo admin is recommended. Outbound access must permit GHCR pulls, GitHub Actions SSH, DNS, NTP and ACME/TLS.
- **Deliberately no custom Docker firewall chains in FP-003B.** UFW alone does **not** reliably filter Docker-published ports; consequently publish **no** Postgres, API, Web, Redis or Docker daemon ports at all. Do not use `network_mode: host`, `privileged: true`, external host binding `0.0.0.0:3000`/`5432` or a second published port. Verify actual host listeners and outside port scan for IPv4 **and** IPv6. Do not disable Docker's networking/firewall management.
- Standard Docker private networks (edge and backend), least-privilege container users where practical, restart policies, bounded log rotation and resource limits. No exposed Docker socket to application containers. HTTP health endpoint must not disclose database identities or secrets.

**Illustrative Caddy semantics, not ready-to-run config:** site `panel.fairisfair.ir`; global `auto_https disable_redirects`; `tls { issuer acme { disable_http_challenge } }`; reverse proxy same-origin `/api/v1/owner/*` to the Owner API, otherwise Web. Enforce no UDP/443 host mapping and use HTTP/1.1/HTTP/2. Validate actual Caddyfile in integration tests before release.

## 4. One Owner account: CLI-only enrollment and recovery

- **Exactly one Owner identity** per Fair staging deployment. **No Register/Create Account endpoint/page**, no email-based open signup, no forgot-password public recovery, no invitation, no owner list management in FP-003B.
- A one-time non-public **interactive CLI** (suggested command `owner:bootstrap`) creates the Owner after schema migrations. Operator supplies a strong unique password through a terminal with input echo disabled or chooses cryptographically random generation. Never take password as an argv flag, URL, committed file or printed GitHub Action value. Store **Argon2id password hash only**, with a unique DB-level singleton invariant and atomic insert so concurrent bootstrap attempts cannot create a second Owner.
- Subsequent bootstrap calls fail cleanly without disclosing Owner details; normal startup must **not** bootstrap a default account automatically. No hardcoded username/password, no `OWNER_PASSWORD` in `.env`, Docker labels, images or GHCR.
- Recovery CLI commands `owner:reset-password` and `owner:revoke-sessions` run **only from a trusted host/admin console** with the same strict database scope. Password resets revoke all sessions; rotated sessions are not resurrected. CLI must not offer account duplication.
- Owner login route `POST /api/v1/owner/auth/login`, logout route `POST .../logout`, current session route `GET .../session`. Login returns generic invalid-credentials response and is rate-limited, including cross-process/concurrent failures. No public user enumeration. Owner UI pages and all Owner API endpoints require authentication except login/explicitly public liveness checks.
- Opaque, cryptographically random, rotation-capable **server-side sessions**; only a hash of session token in PostgreSQL. Use HttpOnly, Secure, SameSite=Strict, Path-restricted cookie (if possible without breaking UI), expiry and session rotation on login; no tokens in localStorage. Recommended initial session policy: 30-minute inactivity and absolute 12-hour lifetime; implement enforcement server-side, not only cookie Max-Age.
- Same-origin CSRF strategy for state-changing login/logout, verified Origin/Referer plus antiforgery token or equivalent well-tested guard. Enforce HTTPS, login POST and no login CSRF; protect against session fixation and timing/user enumeration; use constant-time matching where applicable.
- Forwarded headers/secure cookies work through Caddy but cannot be spoofed directly via raw external API access. Route `/api/v1/owner/*` only via Caddy. Safe server-side auth logs exclude passwords, tokens, cookies, usernames and raw login bodies.
- Owner/session schema changes require additive, reversible-in-disposable-db TypeORM migrations, explicit retention/cleanup of expired sessions, session revocation, and isolation from accounting ledger. **No business/accounting writes by dashboard**.

## 5. Operational dashboard contract

Default rolling range: **last 24h UTC**, with selectable 1h, 24h, 7d and 30d; validate bounded half-open `[start,end)` UTC intervals, maximum 30 days, and source-instance filter. Empty or synthetic test data must be labeled truthfully. Do not conflate persisted *distinct logical* events and input child occurrences.

Suggested stable endpoint surface:
- `GET /api/v1/owner/operations/summary?window=24h&source=...`
- `GET /api/v1/owner/operations/events?window=24h&limit=25&cursor=...`
- `GET /api/v1/owner/operations/issues?window=24h&limit=25&cursor=...`
Use strict allowlisted query types and capped limit (default 25, max 100). Cursor is opaque, signed or validated, order stable descending by timestamp + immutable PK. No arbitrary SQL sorting/identifiers. All identifiers returned as decimal strings when BIGINT.

Four distinct operational cards:
1. **Received Batches**: `COUNT(*)` of `pasarguard_webhook_batches` with `received_at` within time range, after storage deduplication, scoped to source. Not a count of physical HTTP attempts.
2. **Normalized Events**: `COUNT(*)` of `pasarguard_events` with `created_at` in range, scoped to source, counting distinct persisted normalized rows. Not the number of child occurrences or accounting charges.
3. **Open Ingestion Issues**: `COUNT(*)` of `pasarguard_ingestion_issues` where `resolved_at IS NULL` and `created_at` in range, joining their batch and source. This is issues created in the window still open, **not the global backlog**; label explicitly.
4. **Failed Batches**: batch rows with `processing_status IN ('FAILED_RETRYABLE','FAILED_PERMANENT')` and `received_at` in range, scoped to source, measured at query time. Expose the per-status counts where helpful.

Recent events sorted by `source_enqueued_at DESC, id DESC` but default window classification for this list uses **source event time**, not receive time; show separate source and first-seen timestamps when permitted. Allowlist: action, external user ID (synthetic only), user status, data-limit bytes, source timestamp, event status, Billing Admin ID (synthetic only), safe Actor status (no need to expose usernames), occurrence count. Avoid raw `user` fields, subscriptions, credentials, fingerprints and ciphertext.

Recent issues sorted by `created_at DESC,id DESC`; allowlist: fixed issue code, sanitized fixed issue message, batch index, created timestamp, resolved status and opaque row ID. No raw payload or arbitrary metadata, private replay files, administrative keys or live user data.

Never claim the `READY_FOR_ACCOUNTING` status means charged; no financial balance, outstanding debt or real-time "connected to Pasarguard" indicator. Pending/failure of a data source must be visibly distinct from zero events. Views are read-only; login/logout/session writes are the narrowly defined exception.

## 6. Staging database, lifecycle and seed

- Separate Fair PostgreSQL 17 container on the dedicated staging VPS, **persistent Docker named volume**, container-internal network only. No public port, no shared Pasarguard/TimescaleDB DB/user/volume; `synchronize:false`; explicit FP-001 schema migrations + separate additive Owner/session migration. FP-002 accounting migration if necessary for future schema compatibility **must not create charges**.
- Initial dataset uses **only checked-in synthetic fixtures or a synthetic seeder** that calls the real FP-001 normalization path with fake identifiers. Seeder is explicitly invoked at one-time installation/demo reset, idempotent, and **not** automatically re-run on every deploy. Use no private 1/7/30-day replay files or sanitized owner business data.
- Separate database roles where practical: migration/admin role, runtime Owner API least privileges (read on operational tables; write only Owner/session/audit records), and a backup credential. Do not grant financial ledger write privileges to dashboard API.
- Persistent database retains state across container restarts and repeated deployment; data backup is mandatory before risk-bearing migrations; retention/cleanup for synthetic demo and expiring sessions. No automatic destructive `docker compose down -v` or destructive migration in deployment jobs.
- Environment secrets live exclusively on the server in restricted `0600` operator-managed files or container secrets; never checked in, embedded in images, logged or printed. GHCR registry credentials only if packages require authentication.

## 7. Docker images, Compose and staging release contract

- Build `fair-web` and `fair-owner-api` as reproducible multi-stage Docker images (Node 24 LTS runtime), `linux/amd64` target matching approved VPS; non-root runtime, production-only dependencies, pinned base image versions/digests, health check and graceful SIGTERM. Do not build source on the VPS.
- Use pinned official images for Caddy and PostgreSQL 17. Caddy alone binds `443:443/tcp`. Web/API/Postgres **must use Docker internal networking only**, with healthcheck and dependency readiness (not just `depends_on` ordering). Do not run general FP-001 webhook worker or receiver in staging.
- Compose project name and named volumes are staging-scoped. `/data`/`/config` Caddy persistence, PostgreSQL data persistence, deterministic container names or Compose service discovery. Never replace volume or reset DB during a normal release.
- Deploy **immutable image digests** recorded in a release manifest, tied to the exact `development` merge SHA. Do not use mutable `latest` as the deployment selector. Avoid `docker system prune --volumes` and unbounded log/image buildup; clean only known, unused image objects after safe retention.

## 8. End-to-end GitHub Actions CI/CD

Required pipeline for all PRs to `development`/`main`: frozen install, format, lint, TS typecheck, PostgreSQL 17 integration/E2E and builds; relevant auth, dashboard and Compose/Caddy tests; dependency/secret/container scanning. **No deployment and no staging secrets on PR workflows**, including forks.

**After the human Owner merges to `development`**:
1. GitHub-hosted runner checks out immutable merge SHA; reruns/verifies required CI and security gates. Never assume an earlier PR check covers the merged result.
2. Build Web/API Docker images and scan them. Push to GHCR using scoped `GITHUB_TOKEN` with `packages:write` only in publish job; use least `contents:read` elsewhere. Record SBOM/provenance/image digests as permitted by repo policy, without secrets.
3. Staging `environment` is restricted to protected `development`; only the deploy job can read its **SSH private deploy key**, target hostname and pinned host SSH key fingerprint/known_hosts. No self-hosted runner or production Docker socket inside CI. Separate noninteractive deploy identity; do not use Owner's personal SSH key or root.
4. Via SSH **TCP 22** deploy an immutable, validated release manifest and permitted Compose/Caddy config. On host: verify prerequisites, check/backup DB if migrations require, acquire deployment lock, verify image digests, pull images, apply **additive/backward-compatible migrations only by default**, launch desired version, check DB/app readiness, external HTTPS/certificate and authenticated smoke test without exposing credentials.
5. Atomically mark deployment successful and preserve previous image digests/release metadata; on application-only health failure, revert images/config to last healthy release **only if schema compatibility is proven**. If DB migration failed/was destructive or incompatible, **STOP and alert, no automated database restore or blind rollback**.
6. Deploy concurrency **one per staging environment**, no interleaved releases; newer deployment supersession must be handled without corrupting the current one. Status, SHA, digests, smoke results and sanitized failure code visible in Actions; never expose passwords/keys/SQL rows.
7. **No manual approval on every ordinary staging deploy** once the Owner has approved initial setup/activation and protected-branch policy. GitHub Actions automatic staging release is authorized by Owner-merged `development`, **not** automatic merging and not automatic production release.

A separate `main` release workflow is future scope, not enabled in FP-003B. Do not add `pull_request_target` or expose environment secrets to untrusted PR code. GitHub Actions permissions should be job-minimal; pin third-party actions to reviewed versions/SHAs in implementation.

**Deploy-user security tradeoff:** membership in the Docker group or arbitrary `docker compose` is effectively root on the host. Prefer a narrowly constrained root-owned deployment entrypoint/allowlisted command, restricted files and noninteractive SSH; any fallback using Docker group is **explicitly a high-privilege exception requiring Owner security acceptance**. Check server's actual SSH/host configuration rather than claiming a dedicated deploy key is low-privilege by itself. Keep human SSH administration key separate. No GitHub-hosted deployment is permitted before Owner completes and validates one-time server setup.

## 9. Backup, monitoring and operational recovery

- PostgreSQL scheduled **encrypted off-host backup** with tested retention, alert on failures, and restore drill into a *different disposable/isolated* PostgreSQL 17 instance. A same-server-only Docker volume is **not** a backup.
- Caddy `/data`/`/config` persist and are recoverable; secrets can be re-provisioned by Owner. Keep a rollback-safe release manifest history and sanitized deployment/audit events.
- Health: minimal unauthenticated liveness endpoint with no private details; readiness must test actual DB session/operational query capability; no database rows or secrets in diagnostics. Outside HTTPS 443 TLS/cert expiration monitored. Failed CI/deploy, failed backup and failed certificate renewal alert.
- Recoverability tests: restart, reboot, lost database, stale sessions, certificate renewal, failed deploy, healthy previous digest, unsuccessful restore, and host operator break-glass via provider console.
- Initial **staging rollout** requires Owner go-live authorization (domain/DNS, SSH keys, UFW, Docker installation, encrypted secrets, Owner bootstrap, backup target). Thereafter **normal `development` merges deploy automatically**. Operators/agents do not initiate production SSH, live integrations or `main` promotion.

## 10. Required adversarial verification and gates

Minimum acceptance coverage:
1. GitHub `development` merge pipeline green on actual merge SHA; no deploy from PR or `main`.
2. GHCR digests match release, no mutable tag reliance; failed build/scan prevents deploy.
3. Server bootstrap is one-time and idempotently rejects second concurrent Owner; no signup/reset-web endpoint; CLI does not leak password.
4. Password hashing Argon2id; generic login failure and rate limiting including concurrent attempts.
5. Server-side session persistence, rotation, idle/absolute expiry, logout, CLI revoke/reset, CSRF/cookie flags, forwarded-header spoof prevention.
6. Unauthenticated/expired session cannot call any Owner read endpoint or load private dashboard data.
7. Four KPIs match seeded rows at time boundary and source filter; no conflation of receipt, source, persisted event or physical-delivery counts.
8. Stable cursor pagination across tied timestamps; capped page/range; malformed/overflow IDs rejected.
9. Safe response allowlist; zero raw payload, secrets, credentials, private replay evidence or financial posting.
10. Persistent data and session behavior survive API/Caddy/container restart without losing database volume.
11. Operational API does not start webhook controller; original production webhook fail-closed guard stays active.
12. Internet scan: only TCP/22 and TCP/443 reachable, no TCP/80 or published internals; test IPv4 and IPv6 when configured.
13. TLS-ALPN certificate issued/renewable through 443 with 80 closed; Caddy certificate storage persists.
14. Login/dashboard usable from a normal internet-connected phone and desktop; no SSH tunnel or VPN needed.
15. Host credentials not in GHCR images, Git history, GitHub logs or public PR checks; SSH host-key pinning resists spoofing.
16. Automated deployment lock, rollback to last compatible image on failed app health, fail-closed incompatible migration, no destructive volume cleanup.
17. Encrypted off-host backup succeeds and isolated PostgreSQL restore was actually tested.
18. Authentication, DB, image, DNS and certificate outages produce bounded/fail-safe responses and operator-visible alerts.
19. Full repo and security test gates, independent Review PASS, independent QA PASS, GitHub CI green, plus Owner-verified first end-to-end staging acceptance.
20. No change to accounting semantics or live financial/production behavior; **the human Owner alone marks PR Ready and performs Merge**.

## 11. Implementation handoff and blocking questions

The Implementation Agent may start **only after the Owner explicitly approves this specification and design choices**. Suggested work areas: `apps/web`, new Owner API mode in `apps/api`, `packages` auth/application/infrastructure as justified, staged TypeORM migration/CLI, `docker/` prod Compose/Caddy/Dockerfiles, GitHub workflow(s), tests and docs. Do not preemptively create branches or modify hosts.

Human-operated **one-time prerequisites**: actual VPS provider/IP and whether IPv6 enabled; DNS A/AAAA, issuer contact email; test SSH login (22/key only) and rescue console; host OS; Docker Engine/Compose and UFW baseline; dedicated deploy identity and validated privileges; GitHub environment/registry availability; secure secrets and off-host backup destination. These can be injected/configured at rollout without rewriting core application design.

**STOP/escalate** if real constraints demand opening TCP/80, introducing Cloudflare proxy, exposing a database port, bypassing webhook authentication, installing a privileged runner, making destructive migrations or changing the Owner-only merge policy. Such changes require the Owner's explicit new design approval.

**Spec gate:** DRAFT until Owner accepts its implementation details separately; documentation PR merge alone does not imply production activation, billing activation or agent implementation authorization.
