# Security Policy

## Secrets
No production secret belongs in Git, issues, PRs, logs, screenshots, fixtures, or documentation examples.

## Sensitive Pasarguard Data
Raw webhook payloads may contain subscription URLs and proxy credentials. They are short-lived debugging data, protected at rest by deployment controls, never indexed wholesale, never copied into normalized business tables, and purged by retention.

## Logging Redaction
Never log Pasarguard API tokens, Telegram bot tokens, webhook secrets, session secrets, subscription URLs, proxy credentials, passwords, or private keys.

## Authentication
Owner authentication uses strong password hashing (Argon2id direction), server-side sessions, Secure/HttpOnly/SameSite cookies, CSRF protection where relevant, rate limiting, session rotation, and audit logging. Do not store JWTs in localStorage.

For FP-003B the Owner selected **public HTTPS** on `panel.fairisfair.ir` (Cloudflare DNS-only, Docker Caddy automatic TLS-ALPN-01, no HTTP/80, no public UDP/443), **not** private tunnel/VPN. Implementation was explicitly approved on 2026-10-14; first staging setup/deployment/activation remains separately pending. No Owner dashboard data/API is public: deny all unauthenticated access, apply bounded allowlisted responses, session/cookie security, rate limiting and CSRF protections. Use a dedicated Owner API runtime that **does not register any webhook routes**; do not weaken the production webhook authenticator fail-closed behavior. Login/logout/session writes are allowed; operational and financial business data remain read-only.

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

## Public Staging SSH, Network and CI/CD
FP-003B SSH remains **TCP/22, key-only**, with password/keyboard-interactive login disabled after key access and provider rescue are verified. TCP/443 is the only web ingress; TCP/80 remains closed. Host UFW default deny inbound allows 22 and 443. **UFW does not reliably filter Docker-published ports**: FP-003B publishes **only Caddy TCP/443**; database, API, Web, Docker socket and other services remain un-published. No custom Docker firewall chains in FP-003B. Check external IPv4 and IPv6 listeners.

GitHub Actions publishes reviewed images to GHCR and deploys STAGING automatically **only after an Owner merge to protected `development` and successful CI**, following an Owner-approved one-time setup/go-live. PR/fork workflows never access SSH deploy secrets. Use a dedicated deploy key and SSH known-host pinning; do not use Owner's personal key. **Docker group / unrestricted Compose access is effectively root**: the deploy account must be restricted or its high privilege separately accepted by the Owner. Secrets reside off-repository; no self-hosted runner is authorized here. Failure/rollback must not destroy or automatically restore DB data. See [FP-003B spec](tasks/FP-003B-operational-dashboard.md).

## Production Access
AI agents do not receive autonomous production SSH/deploy authority. **Automatic public STAGING deployment is not later live production deployment.** The human Owner controls initial staging activation, all PR merges, production credentials and any future actual production deployment.
