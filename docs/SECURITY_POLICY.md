# Security Policy

## Secrets
No production secret belongs in Git, issues, PRs, logs, screenshots, fixtures, or documentation examples.

## Sensitive Pasarguard Data
Raw webhook payloads may contain subscription URLs and proxy credentials. They are short-lived debugging data encrypted in the ingestion pipeline with authenticated AES-256-GCM **and** protected at rest by deployment/secret-access controls, never indexed wholesale, never copied into normalized business tables, and purged by retention. Encryption does not permit private webhook fixtures to enter public synthetic Staging.

## Logging Redaction
Never log Pasarguard API tokens, Telegram bot tokens, webhook secrets, session secrets, subscription URLs, proxy credentials, passwords, or private keys.

## Authentication
Owner authentication uses strong password hashing (Argon2id direction), server-side sessions, Secure/HttpOnly/SameSite cookies, CSRF protection where relevant, rate limiting, session rotation, and audit logging. Do not store JWTs in localStorage.

For FP-003B the Owner selected **public HTTPS** on `panel.fairisfair.ir` (Cloudflare DNS-only, Docker Caddy automatic TLS-ALPN-01, no HTTP/80, no public UDP/443), **not** private tunnel/VPN. It was approved in October; the Owner reports actual Persian synthetic Staging activation after later reviewed merges. No Owner dashboard data/API is public: deny all unauthenticated access, apply bounded allowlisted responses, session/cookie security, rate limiting and CSRF protections. Use a dedicated Owner API runtime that **does not register any webhook routes**; do not weaken production webhook authentication. Login/logout/session **and authenticated, CSRF-protected, audited FP-004 synthetic pricing-configuration writes** are allowed. Real accounting posting, production webhooks and money-changing writes remain forbidden. Read-only real Pasarguard admin-directory lookup is a **proposed, separately credential-gated exception** limited to ID/username via official HTTPS API, never its database.

## Bootstrap
Create **exactly one** Owner through an interactive, one-time, **non-public CLI** after migrations; enforce singleton in PostgreSQL atomically. No Registration/Create Account or public password-reset endpoints. Password is Argon2id-hashed; never accept a password in CLI argv, `.env`, GitHub Secrets or logs. Only trusted administrator CLI operations can reset the password and revoke sessions. Password reset revokes all sessions. Store only hashed opaque session tokens in PostgreSQL, with HttpOnly/Secure/SameSite cookies, rotation, inactivity/absolute expiry and server-side logout. Permanent Owner passwords do not live in `.env`.

## Application Secrets
Runtime integration secrets may be stored encrypted with an external master key/environment secret. UI masks secrets and changes are audited.

## Environment
Keep `.env` minimal and deployment-oriented. Do not place runtime/tool versions in `.env`.

## Telegram
Fair has its own bot token. Pasarguard admin Telegram destination remains sourced from Pasarguard rather than becoming authoritative local profile data.

## Dependency / CI Security
Use dependency updates, CodeQL, secret scanning, Trivy/container scanning, and package audit as CI evolves.

The [Owner-directed image/advisory review](security/STAGING_IMAGE_AND_ADVISORY_DECISION_2026-11-19.md) documents the **current disposition and deadlines**. `picomatch@4.0.7` is **present in the production API image** as well as development tooling; its GitHub GHSA was **withdrawn 2026-11-18**, but NVD still lists the CVE and no confirmed compatible fix exists. Picomatch Trivy waivers expire **2026-12-02**; Caddy go-jose-v3 (unpatched v3) expires **2026-12-15**. `pnpm-workspace.yaml`'s `audit.ignore` has **no automatic expiry**. Both remain **residual risks**, not vulnerability fixes: expire/fail closed and require a distinct Owner decision before any renewal. A green CI under an exception is not evidence of remediation.

## Public Staging SSH, Network and CI/CD
**Original ADR 0015 goal:** SSH TCP/22 key-only, password/keyboard-interactive disabled. **Current explicit exception for existing synthetic Staging (ADR 0016):** a masked **root-password SSH bootstrap secret** in the protected `staging-bootstrap` GitHub Environment, pinned ED25519 host identity, plus a freshly provisioned, forced-command **ephemeral deployment key**. This is **not key-only host authentication** and retains high root privilege; it must never be represented as hardened production SSH. The Owner accepted deferral of further host SSH hardening for this disposable VPS. TCP/443 is the only web ingress; TCP/80 remains closed. Host UFW default deny inbound allows 22 and 443. **UFW does not reliably filter Docker-published ports**: FP-003B publishes **only Caddy TCP/443**; database, API, Web and Docker socket remain un-published. Check external IPv4 and IPv6 listeners.

GitHub Actions publishes reviewed images to GHCR and deploys STAGING automatically **only after an Owner merge to protected `development` and successful CI**. PR/fork workflows never access SSH deploy secrets. Host identity is pinned and the deploy key has a restricted forced command, but **the root-password setup phase is still root-equivalent**. Secrets reside off-repository; no self-hosted runner is authorized here. Failure/rollback must not destroy or automatically restore DB data. **ADR 0017 deliberately removes all automated Staging database backup/restore**; app-only image rollback is not data recovery, and irreversible loss of synthetic data is accepted. Do not apply this exception to any future financial/live environment. See [Staging status and decision sequence](CURRENT_STATE_AND_POLICY_2026-11-19.md).

## Agent execution: program cancelled
**Owner cancelled the autonomous development agent/orchestrator program on 2026-11-19.** No new unattended queue, agent session or Lab bootstrap is authorized or required for current PR acceptance. Historical code and documents remain; this policy does not claim to remotely stop laptop-local processes. If the program is expressly restarted later, `danger-full-access` and separate Git worktrees do **not** isolate files, credentials or network; use an isolated least-privileged OS account/VM **before** reactivation. The **current** process is human/interactive review plus CI, with Owner-only Ready/Merge.

## Production Access
AI agents do not receive autonomous production SSH/deploy authority. **Automatic public STAGING deployment is not later live production deployment.** The human Owner controls initial staging activation, all PR merges, production credentials and any future actual production deployment.
