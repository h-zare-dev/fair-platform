# FP-003B — Public Staging Operations and Delivery Runbook (Design Contract)

**Status:** DRAFT operator runbook; commands are **plans**, not evidence of a configured server. See [FP-003B task specification](../tasks/FP-003B-operational-dashboard.md) and [ADR 0015](../adr/0015-public-https-staging-and-controlled-delivery.md).

## Environment identity

- Domain: `panel.fairisfair.ir`, Cloudflare **DNS-only** (grey cloud).
- Machine: dedicated STAGING VPS, not Pasarguard/Pasarjew and not eventual production.
- Public inbound: **TCP/22 for OpenSSH key-only**, **TCP/443 for Caddy HTTPS**. Closed TCP/80; no published UDP/443. Host firewall: **simple UFW**, no custom Docker-specific rules in this phase.
- App containers: Caddy, Next.js Web, NestJS Owner API, PostgreSQL 17 and optional one-shot migration/backup tasks. FP-001 webhook worker/receiver and live billing remain **OFF**.
- Host has minimal Docker Engine + Compose plugin, SSH, UFW and OS/security prerequisites; "all Docker" means app services are containers, not that the Linux host has literally no packages.

## Before first deployment — human Owner/operator checklist

1. Provision isolated VPS and record its provider rescue/console entry. Decide IPv4/IPv6 support and confirm both DNS record families are accurate; do not publish unused AAAA.
2. Install/configure Docker Engine + Compose, OpenSSH, UFW; preserve OS automatic security updates. Authenticate to SSH with a public key from a **new independent terminal session** before disabling password and keyboard-interactive authentication. Keep Provider console verified as break-glass. SSH port stays 22.
3. UFW default deny inbound, allow 22/tcp and 443/tcp; do not publish Docker internal ports. Verify host listeners and public IPv4/IPv6 scan. Docker port publishing can bypass UFW rules: prevention is **not publishing unwanted ports**.
4. Point Cloudflare DNS-only A/AAAA to the reachable host; check CAA if configured. ACME issuer must connect on 443 for TLS-ALPN-01; HTTP-01 and redirect must be explicitly disabled, since 80 remains closed. Persist Caddy certificates.
5. Set up a staging `development`-only GitHub Actions Environment, GHCR publish/pull credentials as required, a dedicated SSH deploy key, **pinned known_hosts/host fingerprint**, and a noninteractive deployment entrypoint. Restrict deploy key privilege; **Docker group is root-equivalent** and needs explicit Owner signoff if used.
6. Provision restricted server-side runtime secrets (Owner session token secret, database credentials, any registry secret), Compose configuration, PostgreSQL persistent volume and separate backup destination. Do **not** store Owner password as an environment variable, in GitHub Secrets or on disk.
7. Run explicit Fair migrations in the approved order on the staging database; run the interactive Owner bootstrap CLI exactly once through the trusted console. Verify repeated bootstrap cannot create another account.
8. Seed approved **synthetic** event/issue data explicitly one time, using normal processing rather than writing secret-bearing records; never use private historical replay input or copy production databases.
9. Set up encrypted off-host backup and **prove restore** to an isolated target before declaring deployment complete. Configure alerting for backup, deploy and TLS problems.
10. Owner authorizes **initial staging go-live** only after external HTTPS/phone login, auth denial, DB retention, listener/port scans and tests are PASS. Routine future `development` merges then deploy automatically.

## Automatic release workflow (post-initial setup)

- Trigger: **push to `development` after human Owner merge**. PR workflows run quality but **never** use staging secrets or deploy.
- Gate: frozen pnpm install, format/lint/typecheck, real Postgres17 integration/E2E, build, relevant security checks, reviewed dependency/secret and container scans.
- Publish: Docker multi-stage images into GHCR; capture exact immutable digests/merge SHA, attest allowed image metadata, do not push confidential environment values.
- Deploy: CI job restricted to the protected `development` staging environment, serialized by deployment lock; SSH 22 with pinned host key and a dedicated credential. No self-hosted runner. Existing host compose/app data belong to **staging only**.
- On host: fail preflight if DB/backup/permissions invalid; run only compatible migration; pull/apply pinned digests; wait for health/readiness; HTTPS smoke and authenticated non-sensitive check; mark release complete or safe app-only revert (when schema backward compatible).
- Failure: stop, alert, preserve logs/evidence and last known good manifests. **Never automatically restore or destroy the DB** to cover a migration problem. If no safe automatic rollback, require Owner intervention.
- Success: published site updates on its own without the Owner manually invoking SSH/Compose. This automation **does not** approve or execute the GitHub Merge itself.

## Operator recovery paths

- Bad app image: redeploy previous known-good **digest** after confirming DB schema compatibility.
- Failed migration: stop; preserve DB; inspect operation and backup; do **not** blindly run DOWN migration on populated DB or delete PostgreSQL volume.
- Invalid session/locked Owner: CLI `owner:reset-password` and `owner:revoke-sessions` through trusted admin channel; no public password reset page.
- Caddy cert issue: verify DNS-only A/AAAA, CAA, ingress TCP/443, Caddy persistent data, issuer rate-limit/errors and configured TLS-ALPN; do not open TCP/80 behind the Owner's back.
- Lost SSH: provider console/rescue. Do not rely on GitHub Actions for sole server recovery path.
- DB loss: use last verified encrypted off-host backup and isolated restore test, decide recovery with Owner; never replay private Pasarjew data to staging.
- Rollout drift: compare current VPS and GitHub Environment against this runbook and ADR before expanding to live production.

## Local/CI verification and documentation outputs

Implementation must supply redacted examples for Compose/Caddy, an environment-variable **name-only** inventory, migration ordering, bootstrap/recovery CLI usage, GitHub workflow diagram, SSH deploy limitations, backup schedule/restore test and release/rollback procedure. All operator instructions need real reproducible tests, not invented "verified" claims. PR documentation should distinguish `PLANNED`, `TESTED` and `DEPLOYED` states.

Official references: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy Caddyfile options](https://caddyserver.com/docs/caddyfile/options), [Docker published ports](https://docs.docker.com/engine/network/port-publishing/), [Docker & UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/), [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).
