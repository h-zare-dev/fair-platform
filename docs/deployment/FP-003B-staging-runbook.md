# FP-003B — Public synthetic Staging release runbook and historical design notes

**Status (2026-11-19):** Owner reports Persian Staging dashboard activated after reviewed merges. **The first "Current staging post-merge procedure" section is operative; older bootstrap/backup/SSH instructions below are historical and must NOT be applied to the current VPS.** Live current SHA/health still requires host evidence. See [current-state policy](../CURRENT_STATE_AND_POLICY_2026-11-19.md), [FP-003B historical spec](../tasks/FP-003B-operational-dashboard.md), and ADRs [0015](../adr/0015-public-https-staging-and-controlled-delivery.md), [0016](../adr/0016-disposable-staging-local-backup-and-owner-merge-cd.md), [0017](../adr/0017-no-automatic-backup-for-disposable-synthetic-staging.md).

> **Latest Owner override (2026-11-18):** For this *existing, synthetic-only* staging VPS, [ADR 0017](../adr/0017-no-automatic-backup-for-disposable-synthetic-staging.md) supersedes ADR 0016's local-backup/restore requirement. **Neither pre-deployment nor periodic backup/restore runs** after the Owner merges the reviewed no-backup change. The existing backup timer is disabled, but old backup archives are not deleted. Losing staging data may be irreversible. No production or live finances are authorized. Sections below describing mandatory backup/restore are historical design notes, **not current instructions for this VPS**.

### Current staging post-merge procedure

1. The Owner alone merges the reviewed Draft PR to protected `development`. No other manual trigger or server command is needed for an ordinary application-only release.
2. Actions `CI` must pass `quality`, `security`, `containers`, `owner-merge`, `publish` and `deploy`. `deploy` uses the already configured `staging-bootstrap` environment and pinned SSH host fingerprint. It retains the accepted PostgreSQL image, not the freshly rebuilt PostgreSQL helper's digest.
3. The approved no-backup activation policy is `staging-no-backup-v1`. Existing installations disable `fair-staging-backup.timer`; new installations do not create backup/restore evidence. Both retain exact migration-hash baseline, the health timer and the Owner's existing configuration. No saved backup archives are deleted.
4. The Release verifies GitHub tip, config hash, reviewed migration hashes, database identity and running services, **without backup/restore**, then deploys approved immutable images. A successful workflow emits `STAGING_RELEASE_OK <sha>`. Failures block for investigation; **never** delete `release-state.json` or remove volumes to force deployment.
5. After a green run, open `https://panel.fairisfair.ir/dashboard` and verify Owner login, logout, sessions and synthetic data. Running in staging does not authorize live Pasarguard integration or billing.

**Warning:** A future FP-004 migration change may intentionally stop automatic release until its exact additive migration and hash are reviewed. The pipeline is automatic, but it does not weaken the financial schema-safety gates for unconditional deployment.

**Existing Nov 18 failed backup-phase journal:** A legacy deployment failed in phase `backup` with candidate `5f02f07`. Activation of the no-backup policy does not bypass this unresolved journal. Once the human Owner has merged the new change, only the separate manual GitHub Actions workflow **Staging failed backup journal reconciliation (Owner only)** may resolve this exact incident after rechecking the accepted database, migrations, images, inactive backup timer/service and unchanged high-water. It requires confirmation `RECONCILE_5F02F07_BACKUP_TO_06715BB`; it is not a deployment. A new/retried release is a separate Owner-controlled action.

**Nov 19 follow-up (observed, not yet recovered):** Owner merged PR #76 as `74a1cf8882f45d0201ddadfc6474b276f62e0323`. The no-backup host activation was confirmed by `LOCAL_STAGING_DEPLOY_KEY_ROTATED_NO_BACKUP`; the abandoned backup journal was separately resolved by Owner workflow run `44433266524`. The next CI deployment attempt (`44430504241`, attempt 2) failed with a redacted generic error. Read-only diagnostic run `44434821448` found the *new* `74a1cf8` journal `in-progress` at `preflight` with `completed=preflight`, unchanged accepted/high-water `06715bb...`, healthy services, matching migration hashes, matching PostgreSQL mounts **regardless of order**, and no orphans. It reported `operator_reconciliation_candidate=true`. This is evidence of a safe **candidate for operator review**, not a completed release or license to clear the journal. The exact exception at deploy time is not exposed by the redacted release log; mount-array ordering in `release.py` is a plausible cause, not proven.

After the human Owner reviews and merges the separate narrowly scoped mount-order correction, **only** the manual Owner-only workflow **Staging Nov 19 preflight reconciliation** on protected `development`, with exact confirmation `RECONCILE_74A1CF_PREFLIGHT_TO_06715BB`, may reconcile this one witnessed journal. The workflow must recheck all host, database, migrations, policy, image and orphan gates under `deployment.lock`, preserve an immutable original journal and change only its resolution status. A mismatch fails closed. It does not touch the database or deploy. The Owner must then separately rerun the reviewed new-merge deployment; never rerun the failed earlier attempt or clear journal files by hand.

**Later observed Nov 19 result (supersedes the preceding incident instructions):**
Owner merged PR #77 as `1d862f9fc7b661eef621275413aa124a98580a79`.
The Owner-only Nov 19 preflight reconciliation run `44441926052` passed,
preserved the original journal and confirmed no database or service changes.
The fresh CI #327 (`44439098908`) passed Quality, Security, Containers and
Publish. After the Owner-approved reconciliation, only its failed `deploy` job
was retried; this reached the application rollout and reported
`APP_FAILED_PREVIOUS_RELEASE_RESTORED`. The existing app-only rollback completed.
Read-only Owner diagnostics `44443406584` then found every accepted image,
service health, migration, backup-inactive, PostgreSQL identity/volume and
orphan check passing; accepted SHA remained `06715bb7...`, high-water became
`1d862f9...`, and the resolved journal completed `rollback-smoke`. **The new
Persian dashboard is not yet accepted.** Do not blindly retry the high-water
SHA or disable database gates. The original failed application subphase was
not exposed by the old redacted error code.

**FP-003C staged delivery improvement (Owner-merged PR #78):** See
[`FP-003C Fast Release`](../tasks/FP-003C-fast-release-pipeline.md).
Full browser/backup/restore **synthetic CI tests** remain a PR/full-CI gate;
the protected `development` push keeps quality,
security, provenance, scanned immutable images, migrations, health, smoke and
safe rollback without repeating the long PR integration suite. The next
rollback should identify a fixed safe `startup`, `health` or `smoke` code.
The Owner reports a later Persian dashboard release, but the current public
runtime SHA cannot be inferred from this historical incident paragraph.

## Environment identity

- Domain: `panel.fairisfair.ir`, Cloudflare **DNS-only** (grey cloud).
- Machine: dedicated STAGING VPS, not Pasarguard/Pasarjew and not eventual production.
- Public inbound: **TCP/22 for OpenSSH** (**ADR 0016 permits privileged password-based Staging bootstrap, not key-only**), **TCP/443 for Caddy HTTPS**. Closed TCP/80; no published UDP/443. Host firewall: simple UFW; no custom Docker-specific rules in this phase.
- App containers: Caddy, Next.js Web, NestJS Owner API, PostgreSQL 17 and optional one-shot migration/backup tasks. FP-001 webhook worker/receiver and live billing remain **OFF**.
- Host has minimal Docker Engine + Compose plugin, SSH, UFW and OS/security prerequisites; "all Docker" means app services are containers, not that the Linux host has literally no packages.

## Historical first-deployment checklist — NOT current Staging instructions

**Do not execute this October-era checklist against the activated VPS.** Its
key-only SSH, off-host backup and restore-drill requirements were superseded
**for this disposable synthetic Staging only** by ADRs 0016/0017. Preserve it
as evidence of the original security baseline, not as current authority.

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

## Historical release-workflow design — see current procedure at top

- Trigger: **push to `development` after human Owner merge**. PR workflows run quality but **never** use staging secrets or deploy.
- Gate: frozen pnpm install, format/lint/typecheck, real Postgres17 integration/E2E, build, relevant security checks, reviewed dependency/secret and container scans.
- Publish: Docker multi-stage images into GHCR; capture exact immutable digests/merge SHA, attest allowed image metadata, do not push confidential environment values.
- Deploy: CI job restricted to the protected `development` staging environment, serialized by deployment lock; SSH 22 with pinned host key and a dedicated credential. No self-hosted runner. Existing host compose/app data belong to **staging only**.
- Historical original design mentioned DB/backup preflight. **Current ADR 0017 release never runs or requires a Staging backup/restore**; it still checks database identity, reviewed migration hashes, permissions, digests, health and smoke and permits safe app-only fallback only when compatible.
- Failure: stop, alert, preserve logs/evidence and last known good manifests. **Never automatically restore or destroy the DB** to cover a migration problem. If no safe automatic rollback, require Owner intervention.
- Success: published site updates on its own without the Owner manually invoking SSH/Compose. This automation **does not** approve or execute the GitHub Merge itself.

## Operator recovery paths

- Bad app image: redeploy previous known-good **digest** after confirming DB schema compatibility.
- Failed migration: stop; preserve DB and current incident evidence; **there may be no usable backup**. Do **not** blindly run DOWN migration on populated DB or delete PostgreSQL volume.
- Invalid session/locked Owner: CLI `owner:reset-password` and `owner:revoke-sessions` through trusted admin channel; no public password reset page.
- Caddy cert issue: verify DNS-only A/AAAA, CAA, ingress TCP/443, Caddy persistent data, issuer rate-limit/errors and configured TLS-ALPN; do not open TCP/80 behind the Owner's back.
- Lost SSH: provider console/rescue. Do not rely on GitHub Actions for sole server recovery path.
- DB loss: **no automatic Staging backup/restore exists** under ADR 0017; data may be permanently lost. Escalate to the human Owner for explicit synthetic-instance rebuild decisions; never replay private Pasarjew data to staging.
- Rollout drift: compare current VPS and GitHub Environment against this runbook and ADR before expanding to live production.

## Local/CI verification and documentation outputs

Implementation must supply redacted examples for Compose/Caddy, an environment-variable **name-only** inventory, migration ordering, bootstrap/recovery CLI usage, GitHub workflow diagram, SSH deploy limitations, backup schedule/restore test and release/rollback procedure. All operator instructions need real reproducible tests, not invented "verified" claims. PR documentation should distinguish `PLANNED`, `TESTED` and `DEPLOYED` states.

Official references: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy Caddyfile options](https://caddyserver.com/docs/caddyfile/options), [Docker published ports](https://docs.docker.com/engine/network/port-publishing/), [Docker & UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/), [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).

## Historical original implementation procedures — DO NOT execute on current VPS

The Owner approved this original implementation plan on 2026-10-14. The later VPS activation, root-password bootstrap, no-backup policy and PR #78 fast path **supersede** these historical host procedures. Do not interpret old references to Draft PR #36 or to never-configured infrastructure as a statement about November 19. Local historical evidence is in `docs/implementation/FP-003B.md`.

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

The host takes a nonblocking file lock, verifies authoritative ancestry/high-water and durable recovery state, checks activation, accepted configuration and prior schema, pulls digest images and checks OCI source/revision labels, compares the entire configured migration-name list and migration code hashes (including pending migrations), takes a fresh encrypted off-host backup, runs compatible migrations, and waits for DB/API/Web/Caddy. Public HTTPS/certificate checks and a two-minute CLI-created temporary authenticated smoke session exercise session/summary/dashboard without storing a password or exporting a token. Only after success does it preserve `previous.json`, record the release and atomically update the accepted manifest. On application health failure, it restores compatible prior images/config and reruns smoke checks; migration failure stops for the Owner. There is no DB DOWN/restore, volume removal or broad image pruning. Keep the last known-good manifests and images; operator-managed storage retention must preserve rollback images.

**Not yet evidenced:** actual VPS listener/firewall/SSH restrictions, public issuance/renewal, phone over the internet, off-host transfer/recovery drill, GHCR credentials and first complete SSH delivery. Local/CI simulations do not satisfy those operational gates.

## Historical OD-01 custom-image exception — explicit acceptance reference still missing

Earlier implementation text asserted Owner approval of Caddy and gosu rebuilds. Independent Review could not establish a distinct human authorization; those assertions were withdrawn. **The images were subsequently built/scanned for Staging, but that is not proof of the missing OD-01 Owner signoff.** Current Caddy source is 2.11.9, whereas the original OD-01 image baseline describes 2.11.7. Review the exact deployed digests and record a separate human risk/maintenance acceptance; do not claim approval from this document.

See [decision evidence](../implementation/FP-003B-image-decision.md) for pinned official digests, exact baseline vulnerabilities, supported official alternatives, runtime relevance and maintenance tradeoffs. No scan waiver or infrastructure operation is authorized.

## Historical corrected release implementation notes (later changed by ADR 0017)

All checks run under the host `deployment.lock`, including GitHub evidence checks. `high-water.json` is a root-owned, fsynced server record independent of `current.json`; app rollback never lowers it. On initial use it derives from the human-accepted current SHA. A candidate must equal the GitHub `development` tip and be strictly descended from high-water (GitHub compare status `ahead`, merge base exactly high-water). GitHub data comes directly from HTTPS on the host for this public repository, never from caller-provided JSON. No GitHub credential is required; TLS authenticates the server. HTTP/rate-limit/timeout/malformed/unavailable evidence fails closed. An identical accepted manifest is a no-op only after verification; changed digests with the same SHA, an earlier SHA or a rerun of a rolled-back candidate cannot deploy normally.

The tip/ancestry check repeats after backup, immediately before database/migration/application changes. Advancement before that check rejects the candidate. Advancement afterward can allow this still-descendant release to finish while a newer workflow waits; it cannot replace a newer host-accepted release because the lock covers verification through commit and high-water advances before risky work. This is monotonic host acceptance, not a guarantee the running site always equals a concurrently advancing branch tip. Force-push/unrelated ancestry blocks for human reconciliation. Explicit recovery to earlier app images remains separate from ordinary release admission.

Preflight verifies accepted PostgreSQL is healthy and its actual image reference matches the accepted manifest, then records container ID, image ID and mounts. Candidate tools use `run --rm --no-deps --name ... -T`; they connect to the existing database without dependency convergence. Backup uses `current.env`, `--no-deps` and the named `fair-staging-backup` operation. Rejected compatibility or backup failure does not start/recreate PostgreSQL. The complete migration list and file hashes (now including `OwnerGlobalTimeIndexes1791100000000` / `query-indexes.js`) must be reviewed in `compatible-migrations.json`.

Changing PostgreSQL requires a root-owned `compatible-postgres.json` with exactly `from` (accepted digest), `to` (candidate digest), `sha` (candidate commit) and `schema: fp003b-v1`. The operator must separately validate the engine/helper/entrypoint/data-format transition in disposable tests and approve these exact values; the deploy caller cannot supply approval. Backup must complete first. Only then does a distinct, journaled `up --no-deps postgres` operation occur. Unknown transitions reject before container changes. Applications always start with `--no-deps` and never implicitly converge the database. Container health and unchanged mounts are checked after an approved image transition; database identity is checked again after migration and before app fallback. No automatic engine downgrade, DB restore, DOWN migration, volume deletion or broad pruning exists.

**Journal/re-entry:** `release-state.json` records candidate, prior manifest, accepted DB identity, phase, completion and uncertainty. Each phase is written atomically and fsynced before external work: pull, preflight, backup, database-image/check, migration, startup, health, smoke, rollback database check/stop/startup/health/smoke and commit. Abrupt death leaves `in-progress`; timeout/interruption records `uncertain`. Any non-resolved state blocks the next release. SIGTERM/SIGHUP and subprocess timeouts kill/reap the local process group; failed named one-shots are explicitly removed and checked for absence. A failed backup's named container is explicitly removed. A dead CLI does not imply the Docker operation stopped. Existing named preflight/migration/smoke/backup containers, including stopped/incomplete ones, reject before a new release. Do not delete a journal to bypass this gate.

**Operator reconciliation:** keep deployment blocked, retain the journal/accepted manifests/high-water/backup evidence and inspect named one-shot containers and the database's actual image, mount and migration table against approved hashes. Confirm no Docker operation or SQL migration remains active, and determine whether backup upload/migration completed. Terminate only the identified tooling operation when safe. For uncertain migration/image change, reconcile or repair manually with the Owner; never automatically retry, downgrade PostgreSQL or restore a backup. If app startup/health alone fails after a successful approved migration and healthy unchanged DB identity, automation stops app services, restores prior compatible API/Web/Caddy digests, verifies health/smoke, records the retained database digest and resolves `app-rollback`. Failed rollback/checks leave unresolved state. An operator may mark the journal resolved only after recording the verified outcome and reconciling `current.env`, `current.json`, running containers and high-water under the same lock. Never lower high-water to admit a stale workflow; use a separately controlled recovery procedure.

This PR implements tooling only. Host installation, image-transition approval, new migration-hash approval, public GitHub availability and real first-delivery/recovery acceptance remain operator gates.

Ordinary application releases select the already accepted database digest from the operator-managed **non-secret** repository variable `FP003B_POSTGRES_IMAGE`; missing/invalid values fail manifest validation. The deploy job scans that exact selected image again with unchanged HIGH/CRITICAL and secret thresholds. This variable has not been configured by the agent. CI still builds/scans/publishes PostgreSQL patch candidates, but rebuilding a helper on every app SHA does not automatically replace the accepted database. A deliberate update requires changing the selected immutable digest and installing the exact root-owned transition approval above; this is an infrastructure-image upgrade gate, not per-application-release approval. Retained database images must have valid source/revision OCI labels, but their revision may precede the app SHA. Newly approved database images must match the candidate SHA. No mutable tag is accepted.

### Restore initialization readiness correction

The isolated restore container remains `--network none`, with tmpfs data and no published ports. Wait for `pg_isready -h 127.0.0.1 -U postgres -t 1` inside the container and then a successful loopback-TCP `psql ... SELECT 1` before decrypting/restoring. The official entrypoint's temporary initialization server is UNIX-socket-only, so it cannot satisfy this condition. The readiness loop allows 60 bounded attempts; its one-second interval polls state and is not an assumption that initialization finished. The SQL readiness query has one-second connection and statement timeouts and disables password prompting. `pg_restore` and verification `psql` also explicitly use `-h 127.0.0.1`.

INT/TERM/HUP cause failure exit and the existing EXIT cleanup removes only this isolated container and its temporary encrypted file/diagnostics. Pipeline/decryption/restore/verification failures produce no new success evidence; evidence is atomically written only after restored SQL counts pass. Prior evidence is not refreshed by a failed attempt. This remains a synthetic isolated recovery verification, never an automatic restoration of the accepted database.

`pnpm test:backup` now runs deterministic real PostgreSQL initialization regressions before the original encrypted backup/restore/corruption drill. The test holds the temporary initialization server, observes socket-ready/TCP-not-ready, and confirms the real restore script waits until the hook is released and final SQL readiness succeeds. Additional fresh tmpfs cycles and corrupted, failed and interrupted attempt checks verify cleanup and absent success evidence. Test hooks are confined to disposable test containers; operator tooling accepts no initialization-hook input.
