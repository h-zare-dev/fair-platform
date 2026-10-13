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

## Implementation procedures (PLANNED until Owner activation)

The Owner explicitly approved implementation on 2026-10-14. This does not approve any host operation below. PR #36 remains Draft. Local evidence is recorded in `docs/implementation/FP-003B.md`; no real DNS, TLS issuance, VPS, SSH, backup destination or GitHub environment has been configured by the agent.

### Operator installation and secret inventory

Install reviewed `docker/staging/compose.yml` and `Caddyfile` under `/opt/fair-staging`, and reviewed `scripts/staging/*` under `/opt/fair-staging/tooling`, all owned by root and not writable by the deployment account. Install Docker/Compose, Python 3, curl, OpenSSL, age and rclone from verified distribution sources. Host backup/monitor tooling is outside the application containers. These tools and their updates remain operator-managed.

Create `/etc/fair-staging/secrets` with root-only traversal. Secret files must be `0600`; Docker bind-mounted secret ownership must match the consuming container UID (Node `1000`, backup PostgreSQL `70` in the pinned Alpine image; confirm with `id` before installation). Give Node ownership of `runtime_database_url`, `admin_database_url` and `seed_encryption_key`; PostgreSQL ownership of `backup_pgpass`; keep `postgres_password` root-owned. Do not give the deploy account access to the directory. No permanent Owner password is stored here.

Name-only secret files:

| File | Consumer / purpose |
| --- | --- |
| `postgres_password` | PostgreSQL migration/admin role initial password |
| `runtime_database_url` | Owner API, `fair_owner_runtime`, database `fair_staging`, host `postgres` |
| `admin_database_url` | One-shot migration/bootstrap/recovery/smoke tooling only |
| `seed_encryption_key` | Explicit synthetic seed only, existing FP-001 encryption key format |
| `backup_pgpass` | `postgres:5432:fair_staging:fair_backup` pgpass entry; no password in argv |
| `/etc/fair-staging/alert-url` | Optional operator HTTPS notification sink; restricted `0600` |

The runtime role has column-level operational reads, no raw payload or username reads, no ingestion/ledger writes, and no Owner hash update privilege. A shared PostgreSQL advisory transaction lock serializes trusted password reset/revoke against login without granting runtime credential-update privileges. Cleanup removes expired sessions and audit records older than 30 days. The global shared login budget is 10 attempts/minute, including successful attempts; it cannot be bypassed through spoofed forwarding headers. This deliberately limits a single Owner deployment; an attacker can temporarily consume the budget. Recovery remains CLI-only.

Runtime configuration names: `DATABASE_URL_FILE`, `OWNER_ORIGIN`; tooling additionally uses `APP_ENCRYPTION_KEY_FILE`, `FAIR_DATA_MODE`. Compose settings: `API_IMAGE`, `WEB_IMAGE`, `CADDY_IMAGE`, `POSTGRES_IMAGE`, `ACME_EMAIL`, `SECRETS_DIR`. All four image settings are complete GHCR digest references, never `latest`. `.env` must not contain an Owner password or a session token. Sessions need no reusable signing key: opaque random tokens are hashed using SHA-256 and only the hash is stored. Cookie `__Host-fair_owner` requires `Path=/` for server-rendered page protection, Secure, HttpOnly and SameSite=Strict. Login rotates the presented session; reset/revoke removes all sessions. Idle expiry is 30 minutes, absolute expiry 12 hours. CSRF requires exact HTTPS Origin, JSON content type and `X-Fair-CSRF: 1`, with CORS disabled.

### First installation (trusted console, separately authorized)

Use `docker compose --env-file current.env -f compose.yml` in `/opt/fair-staging` for these operations. Write only non-secret Compose settings and reviewed image digests to root-owned `current.env`.

1. Start `postgres` and wait for its health check. Run `run --rm -T migrate` for explicit migrations: FP-001 inbox, then `OwnerDashboard1791000000000`. The Owner runtime never starts a webhook controller or financial worker. FP-002 tables are not needed by this dashboard and are left untouched if present.
2. Provision roles using `docker/staging/runtime-grants.sql` through the migration/admin console. Use interactive psql `\password fair_owner_runtime` and `\password fair_backup`, then create their restricted secret files. No SQL password literal, CLI flag or CI secret contains the Owner password. Apply grants after schema migrations, before starting the runtime. The role provisioning script is one-time, intentionally not a deploy migration.
3. Bootstrap from an actual trusted terminal: `run --rm migrate node dist/owner/cli.js bootstrap`. Do **not** pass `-T` for this interactive command. Enter and confirm a unique password, minimum 16 characters, with terminal echo disabled. Duplicate/concurrent calls reject atomically. No account is created on application startup.
4. Explicit seed: `run --rm -T migrate node dist/owner/cli.js seed`. It produces 12 stored synthetic batches, 11 normalized events and 2 safe issues. The unknown-action child produces an issue, not an event. The persisted seed anchor makes retries idempotent; it is not reseeded at deployment, and refuses databases containing a different source. As the seed ages out of the selected window, empty data is truthful; no destructive reset is automated.
5. Start applications/Caddy, test real DNS/TLS, IPv4/IPv6 public listeners, phone/desktop access, login denial, logout/recovery, DB restart and Caddy certificate persistence. Only `443:443/tcp` is published; SSH is host OpenSSH. The Owner API ignores forwarding headers and uses exact Origin checks; Caddy removes forwarded client headers before proxying. Health routes disclose only `{ok:true}`.
6. Recovery: `run --rm migrate node dist/owner/cli.js reset-password`; `run --rm -T migrate node dist/owner/cli.js revoke-sessions`; manual cleanup: `run --rm -T migrate node dist/owner/cli.js cleanup`. Never expose these commands as HTTP endpoints. SIGTERM closes HTTP and database connections; API cleanup runs every minute and persistent sessions survive process restart.

### Encrypted backup, restore and monitoring

Configure root-only `/etc/fair-staging/backup.env` with **names** `STAGING_ROOT`, `BACKUP_RECIPIENT`, `BACKUP_REMOTE`, `RCLONE_CONFIG`, `BACKUP_RETENTION_DAYS`. Use a dedicated rclone off-host remote/prefix and a public age recipient; keep the age decryption identity on a separate trusted recovery machine. Recommended operator initial retention: 30 days (script rejects less than 7). Configure the remote credential with only its dedicated backup prefix. `backup.sh` streams PostgreSQL custom-format dump into age, never stores plaintext, uploads only after successful dump/encryption, and expires only `fair-staging-*.dump.age` in that prefix after upload success. The backup role is read-only. Run the timer/service templates as `fair-staging-backup.service` and `.timer`; adjust the timer's service name accordingly when installing. Do not run against any production database.

On the isolated recovery machine, set `BACKUP_OBJECT`, `RCLONE_CONFIG`, `BACKUP_IDENTITY_FILE`, `RESTORE_POSTGRES_IMAGE` (reviewed PostgreSQL image digest) and optional `RESTORE_EVIDENCE_FILE`, then run `restore-verify.sh`. It decrypts through a pipe into a new PostgreSQL 17 container with **no network, no published ports and disposable tmpfs**, uses `pg_restore --exit-on-error --no-owner --no-acl`, checks Owner/event/issue tables, and removes only its own `fair-restore-verify-*` container. A failed decryption/restore exits nonzero. Restore never targets the application DB. After a verified off-host drill, the Owner transfers its `restore-verified.json` evidence to `/etc/fair-staging`; automated deploy requires a successful drill within 30 days. No runtime container receives the recovery key.

Install the health timer/service as `fair-staging-health-monitor.*`, with `Unit=fair-staging-health-monitor.service` in the timer if renamed. It validates public HTTPS readiness and alerts when certificate lifetime is under seven days. Install `fair-staging-alert@.service`; configure/test the Owner-selected alert sink before activation. Backups/health trigger systemd OnFailure and release failures trigger a sanitized operator alert. Enable GitHub Actions failure notifications for quality, security, build and deploy failures. Never log private diagnostic bodies, authentication values or SQL payloads.

### Default-off activation and ordinary delivery

Three independent gates prevent an implementation merge from deploying:

1. Repository variable `FP003B_STAGING_ACTIVATED` must equal `owner-approved-v1`; absent by default.
2. Protected `staging` Environment secret `STAGING_ACTIVATION` must equal `owner-approved-v1`, alongside dedicated `STAGING_DEPLOY_KEY`, `STAGING_DEPLOY_HOST`, `STAGING_DEPLOY_USER`, `STAGING_DEPLOY_KNOWN_HOSTS`. Restrict the environment to protected `development`; no per-release approval after initial Owner acceptance. Pin verified host key data, never use runtime `ssh-keyscan` or disable host checking.
3. Root-owned `/etc/fair-staging/activation.json` must contain `approval: owner-approved-v1`, `schema: fp003b-v1`, `acmeEmail` and `secretsDir`. A previously **human-accepted** `current.json`/`current.env`, recent restore evidence and root-owned `compatible-migrations.json` are required. First automatic installation is rejected.

Before enabling any gate, the Owner must approve and complete first staging acceptance. Obtain migration-file hashes with `run --rm -T migrate node dist/owner/release-check.js`; review against the tested source, and install its reviewed `hashes` and `configuredMigrations` fields as `compatible-migrations.json`. Configuration hash comes from `python3 scripts/staging/config-hash.py`, over exact Compose/Caddy bytes. Populate accepted `current.json` with keys `sha`, `api`, `web`, `caddy`, `postgres`, `schema`, `configHash`; image digests must match the accepted release. Configuration or migration changes require a new operator compatibility review rather than automatic guessing.

Use the reviewed templates `scripts/staging/fair-staging.sudoers`, `scripts/staging/authorized-keys.options` and default-disabled `docker/staging/activation.example.json`; validate sudoers with `visudo -cf` before human installation. Install the deploy SSH public key with forced command `/opt/fair-staging/tooling/ssh-release.sh`, `restrict` and no shell/forwarding/PTY; create a sudo rule allowing **only** root-owned `/opt/fair-staging/tooling/release.py` with **no arguments**. Do not grant Docker group membership, arbitrary sudo, a writable script/config directory or arbitrary Compose commands. Verify the actual account/sshd/sudo restrictions from a separate human admin session. The forced wrapper accepts only `fair-staging-release` and a bounded JSON manifest on stdin. Neither SSH nor CI uploads arbitrary privileged scripts/configuration.

Ordinary chain: Owner merges into protected `development` → actual merge SHA quality/security/browser/container checks → verification of associated PR's `merged_by` Owner → scanned image artifacts → GHCR publish with package-write permission confined to that job → immutable digests → serialized protected deployment. No PR/main/manual-dispatch event deploys; no PR receives staging credentials. Publish records SBOMs; deployment records exact SHA/digests. Third-party actions and official base images are pinned.

The host takes a nonblocking file lock, checks activation, accepted configuration and prior schema, pulls digest images and checks OCI source/revision labels, compares the entire configured migration-name list and migration code hashes (including pending migrations), takes a fresh encrypted off-host backup, runs compatible migrations, and waits for DB/API/Web/Caddy. Public HTTPS/certificate checks and a two-minute CLI-created temporary authenticated smoke session exercise session/summary/dashboard without storing a password or exporting a token. Only after success does it preserve `previous.json`, record the release and atomically update the accepted manifest. On application health failure, it restores compatible prior images/config and reruns smoke checks; migration failure stops for the Owner. There is no DB DOWN/restore, volume removal or broad image pruning. Keep the last known-good manifests and images; operator-managed storage retention must preserve rollback images.

**Not yet evidenced:** actual VPS listener/firewall/SSH restrictions, public issuance/renewal, phone over the internet, off-host transfer/recovery drill, GHCR credentials and first complete SSH delivery. Local/CI simulations do not satisfy those operational gates.

### Caddy security build approval

On 2026-10-14 the Owner explicitly approved replacing the affected official Caddy binary with a reproducible Caddy 2.11.7 source build using Go 1.27.2 and x/net 0.60.0, retaining the pinned official runtime base. See `docker/Dockerfile.caddy` and checked-in Go module locks. CI builds/scans the resulting image and publishes it under the repository Caddy package; normal releases use its digest. This does not authorize a scanner exception, public rollout or host operation.

The Owner separately authorized rebuilding the same gosu 1.19 helper (upstream commit `6456aaa0f3c854d199d0f037f068eb97515b7513`) with pinned patched Go 1.27.2 on the official PostgreSQL 17.11 base after its bundled old Go binary failed scanning. PostgreSQL engine, official entrypoint and data format remain unchanged. See `docker/Dockerfile.postgres` and locked helper module checksums. This is the second explicit official-image hardening exception; no scan waiver, engine upgrade or deployment is authorized. All four runtime images are scanned and selected by digest. Application rollback retains the running PostgreSQL image, uses `--no-deps`, and records that retained digest rather than downgrading the database container.
