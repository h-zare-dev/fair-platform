# ADR 0015 — Public HTTPS Staging and Owner-Controlled Automatic Delivery

**Status:** Accepted for implementation by explicit Owner instruction (2026-10-14). First staging setup/deployment/activation remains separately pending; not deployed or active.

## Context

FP-003B is the next milestone after completed FP-003A/FP-001B, and should be a small **real, internet-facing** version of the future Fair Platform UI, usable from both mobile and laptop. Earlier private SSH-tunnel/Private HTTPS design sketches are superseded. The existing Pasarguard webhook API deliberately fails closed in production, and the historical replay database is disposable. A genuinely public UI requires a separate authenticated, non-financial Owner runtime and isolated persistent staging DB.

## Decision

- Dedicated public staging host, domain **panel.fairisfair.ir**, Cloudflare **DNS-only**, Dockerized Caddy + Next.js + NestJS Owner API + PostgreSQL 17. Caddy obtains HTTPS via **TLS-ALPN-01 on TCP 443 only**, with HTTP challenge and automatic HTTP redirect disabled. Persist Caddy ACME state. Keep HTTP/3 UDP 443 unpublished.
- Keep **SSH TCP 22** reachable for the Owner and automatic release; **SSH key authentication only**, password + keyboard-interactive login disabled after verifying key access and provider rescue. Host UFW simple, TCP/22 and TCP/443 allowlisted. No Docker firewall customizations now, but **never publish private container ports** because Docker-published ports can bypass UFW.
- Exactly one Owner account via **interactive one-time bootstrap CLI** (Argon2id password hash, transactional/DB singleton guarantee), separate CLI-only recovery/session revocation, **no public registration/reset**, secure server-side session and same-origin Owner APIs.
- **Only the Owner** merges PRs. Human merge into protected `development` triggers automated GitHub-hosted Actions quality/security/build → GHCR immutable digests → SSH deployment to staging → safe migrations/health checks/conditional rollback. Initial staging setup/go-live, credentials and destructive DB decisions remain Owner-controlled. No self-hosted runner, no production deploy from `main` or public PR, no privileged Docker socket in application containers.
- Staging metrics derive from a **persistent synthetic Fair DB**, not private replay inputs or Pasarguard production data. No live Webhook acceptance, ledger charging, pricing/classifier logic or accounting cutover.
- This staging topology is **separate** from the later proposed v1.0 production topology on/near the Pasarguard VPS. ADR 0013's human-reviewed shadow cutover is unchanged.

## Consequences and explicit limits

The UI can be exercised over ordinary public HTTPS and ordinary `development` merges can automatically update staging **after one-time human enablement**. TLS/DNS and backups require the Owner's operational prerequisites. Disallowing 80 means plain HTTP will not redirect; DNS-only means no Cloudflare reverse proxy protection. Group access to Docker is root-equivalent and cannot be called restricted just because the SSH key is separate. UFW alone is not a reliable Docker-published-port firewall; no unwanted `ports:`/host networking. No blind database rollback on failed migrations; incompatible changes require a human migration gate. Public availability is not financial/live webhook authorization.

## Supersedes / retains

Supersedes earlier private-access staging proposals and Caddy/Cloudflare-proxied alternatives **for FP-003B only**. Retains ADR 0002 (PostgreSQL truth), 0004 (no Pasarguard database coupling), 0011 (TypeORM/migrations), 0013 (later human-controlled financial cutover), 0014 (NestJS/Fastify).

## Owner-approved security build amendment (2026-10-14)

The Owner authorized rebuilding pinned Caddy 2.11.7 source with patched Go/x/net after the current official binary failed scanning. The runtime remains based on the pinned official Caddy image; the rebuilt binary is dependency-locked, scanned, tested and released by immutable GHCR digest. No security scan exception or deployment authorization is implied.

The Owner separately authorized rebuilding the same gosu 1.19 helper (upstream commit `6456aaa0f3c854d199d0f037f068eb97515b7513`) with pinned patched Go 1.27.2 on the official PostgreSQL 17.11 base after its bundled old Go binary failed scanning. PostgreSQL engine, official entrypoint and data format remain unchanged. See `docker/Dockerfile.postgres` and locked helper module checksums. This is the second explicit official-image hardening exception; no scan waiver, engine upgrade or deployment is authorized. All four runtime images are scanned and selected by digest. Application rollback retains the running PostgreSQL image, uses `--no-deps`, and records that retained digest rather than downgrading the database container.
