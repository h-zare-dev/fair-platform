# Production host candidate — Owner-controlled installation (SHADOW OFF)

**Status:** Owner-controlled host installation tools; the Owner reports a
running UI at `panel.fairisfair.ir`, but CI does not attest the running host.
No live financial billing or production CD is authorized. Review the commit
and await all four `development` images and CI before installing a new release.

## One-command interactive installation and directory configuration

Run as root on a dedicated amd64 Ubuntu console/SSH terminal **after the Owner
merges the reviewed installer PR and its images are published**. Inspect the
downloaded script if necessary before executing it:

```bash
curl -fsSLo /root/fair-platform-install.sh https://raw.githubusercontent.com/h-zare-dev/fair-platform/development/scripts/production/bootstrap.sh && bash /root/fair-platform-install.sh
```

The installer asks permission to install missing Ubuntu Docker prerequisites.
On a **new host**, it fetches only production Compose/scripts with a sparse Git
checkout (not application source), shows the reviewed SHA, asks for the ACME
email, pins immutable GHCR images, provisions secrets, installs the UI, and
prompts for the one-time Owner password with **hidden terminal input**.
It then offers optional **read-only** PasarGuard admin directory configuration:
HTTPS base URL and a hidden API key prompt. The key is stored exclusively at
`/etc/fair-production/secrets/pasarguard_api_key`, UID 1000, mode 0600; it
never enters Compose YAML, `release.env`, shell history or logs.

On an **already installed host** with `/etc/fair-production/installed`, the
same command retrieves the reviewed directory overlay and setup script from
GitHub without overwriting custom files, **even if `.git` and application
source have been removed**. It reuses the pinned release and
existing DB, and **only recreates `owner-api`** to activate the directory;
no database migration, new image pull, Owner re-bootstrap or Shadow activation.
The directory config persists in `/etc/fair-production/directory.env`.

Prerequisites: SSH key/console, SSH and TCP/443 firewall allowance, free port
443 on fresh installs, DNS-only A record for `panel.fairisfair.ir` resolving to
this server, no unexpected AAAA record. Caddy uses 443 TLS-ALPN (no 80).
Preserve Test-Bot, its private archive and identity imports. If GHCR requires
authentication, perform private `docker login ghcr.io` with a read-only token.
`resolve-release.sh` checks image source/revision and immutable digests;
`install.sh` refuses existing volumes, occupied port 443 or partial installs.
SHADOW, real billing, Telegram delivery and synthetic seeding remain OFF.

Health and service check (read-only):

```sh
cd /opt/fair-platform
docker compose --env-file /etc/fair-production/release.env -f docker/production/compose.yml ps
curl --fail --show-error https://panel.fairisfair.ir/health/ready
```

## Optional later: Owner-authorized second webhook SHADOW pilot only

This is a separate **human activation**, not part of first install. Finish
authentication and zero-charge smoke checks first; retain the legacy webhook
destination. Provision a separate, read-only PasarGuard API key on the host as
`/etc/fair-production/secrets/pasarguard_api_key`, owned by UID 1000 and mode
0600, from a trusted non-logged channel. Never put it in shell history. The
`shadow_webhook_secret` was randomly generated in the first-install secret
directory; configure it in PasarGuard as the independent **second** webhook
secret without exposing it in chat or a repo. Then, after explicit Owner signoff:

```sh
cd /opt/fair-platform
docker compose --env-file /etc/fair-production/release.env \
  -f docker/production/compose.yml -f docker/production/compose.shadow.yml config --quiet
docker compose --env-file /etc/fair-production/release.env \
  -f docker/production/compose.yml -f docker/production/compose.shadow.yml \
  up -d --no-deps owner-api
```

The **Shadow overlay** is intentionally not used by the guided installer or
`backup.sh`. It enables the directory **and** encrypted second-webhook
ingestion in `SHADOW` only. The guided installer instead uses the independent
`compose.directory.yml` without any webhook/billing changes. Before separately
enabling Shadow, check the seven-day pilot instructions in
[`WEBHOOK-PILOT.md`](WEBHOOK-PILOT.md) and the authoritative domain rules.

## Backups, release updates and blockers

`backup.sh` writes a `0600` custom-format PostgreSQL dump under
`/var/backups/fair-production/` and validates the dump catalog. **A local dump
is not disaster recovery.** Before any real ongoing data intake, the Owner must
configure encrypted **off-host** copies on a recurring schedule, test an
isolated restore, monitor failures and protect credentials; this PR cannot
choose their storage destination or certify a restore drill. No unattended
backup deletion or database restore is provided. Do not run `down -v`, wipe
volumes, reuse Staging secrets or import the old database automatically.

The initial install is **not** a general update mechanism. For later releases,
Owner reviews schema/migration changes, verifies a restorable off-host backup,
pins the new four digests, runs forward-only approved migrations and rolls
application services in a supervised maintenance window. Do **not** rerun
`install.sh`, automatically replace the PostgreSQL image or borrow Staging's
no-backup/privileged-password SSH and auto-deploy exceptions. A separately
reviewed production release/rollback workflow is required before recurring
unattended deployments.

The historical 122-day SHADOW archive and private identity data remain on
Test-Bot: the fresh database **does not** contain them. Re-import/transfer needs
a distinct, verified migration plan that preserves HMAC identity continuity,
source identifiers and accounting history; never copy `identity-hmac.key`
unreviewed. The old host must not be destroyed until this is reconciled.

**Production readiness verdict:** Owner UI + isolated PostgreSQL and HTTPS can
be rehearsed using this deployment, subject to host tests. **Financial/live
production is not ready:** the seven-day authenticated second-webhook SHADOW
comparison, reliable opening baseline and Update/Reset verification, ambiguity
resolution, off-host restore evidence, production release/rollback controls,
and explicit Owner authorization for settlement/Telegram are still required.
