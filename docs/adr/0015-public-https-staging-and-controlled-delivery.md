# ADR 0015 — Public HTTPS Staging and Owner-Controlled Automatic Delivery

**Status:** Accepted **original design** 2026-10-14, **historical where superseded**. The Owner reports real synthetic Staging activation by 2026-11-19. **ADR 0016 supersedes the key-only Staging SSH/bootstrap method** with protected-Environment root-password bootstrap, and **ADR 0017 supersedes ADR 0016 backup/restore with NO automated Staging backups**. Other HTTPS/auth/isolation/provenance safeguards remain. See [current-state authority](../CURRENT_STATE_AND_POLICY_2026-11-19.md). The October "not deployed" and "OD-01 pending" passages are historical evidence, **not an up-to-date description of the running images**.

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

## Custom-image exception — original OD-01 approval record missing

Earlier implementation text asserted Owner approval of Caddy and gosu rebuilds. Independent Review could not establish a distinct authorization. **Later CI now builds/scans the custom Caddy/PostgreSQL-helper images, and they have appeared in Staging release proposals; this is not retroactive proof of the missing OD-01 Owner approval.** Obtain and record the Owner's exact custom-image and maintenance-risk acceptance before claiming the decision closed. No scan waiver or infrastructure operation is authorized merely by this historical ADR.

See [decision evidence](../implementation/FP-003B-image-decision.md) for pinned official digests, exact baseline vulnerabilities, supported official alternatives, runtime relevance and maintenance tradeoffs. No scan waiver or infrastructure operation is authorized.
