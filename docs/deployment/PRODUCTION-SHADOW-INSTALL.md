# Production host candidate — Owner-controlled installation (SHADOW OFF)

**Status:** installation files and CI regression checks only; **no production host
has been installed, no billing approval has been granted, and no production CD is
configured by this PR**. The old `main` branch is not a deployable release of
the new dashboard. Do not deploy until the Owner approves the reviewed commit,
all PR checks pass, the `development` image publish succeeds and the desired
promotion to `main` has been separately reviewed. Use the immutable **published
`development` commit SHA** (the four GHCR image revisions must all match it).

## Short first-install commands

Prerequisites: dedicated amd64 Ubuntu 26.04 host, root console/SSH **key** and
firewall allowing SSH and TCP/443, free host port 443, working outbound GHCR
access, and Cloudflare **DNS-only** A record for `panel.fairisfair.ir` pointed to
this machine; no unintended AAAA record. Caddy uses TLS-ALPN on 443; **no
HTTP/80**. Do not run on the existing Pasarguard server if another service
owns 443, and do not run any Staging bootstrap workflow here. Preserve the old
Test-Bot server, database, private archive and identity imports.

```sh
# On the NEW Ubuntu host as root; replace the two placeholders.
apt-get update
apt-get install -y docker.io docker-compose-v2 git python3 curl util-linux iproute2
systemctl enable --now docker
git clone --branch development --single-branch https://github.com/h-zare-dev/fair-platform.git /opt/fair-platform
cd /opt/fair-platform
git checkout --detach REVIEWED_40_CHAR_DEVELOPMENT_SHA

# Log in interactively with a package-read-capable token only if GHCR demands it.
# docker login ghcr.io
bash scripts/production/resolve-release.sh REVIEWED_40_CHAR_DEVELOPMENT_SHA owner@example.com
python3 scripts/production/provision-secrets.py
bash scripts/production/install.sh

# Enter the single Owner password interactively; never put it in argv or .env.
docker compose --env-file /etc/fair-production/release.env -f docker/production/compose.yml run --rm migrate node dist/owner/cli.js bootstrap
curl --fail --show-error --head https://panel.fairisfair.ir/login
bash scripts/production/backup.sh
```

`resolve-release.sh` refuses unreviewed commits, inconsistent OCI revision or
source labels, mutable tags and mismatched image digests. The install refuses
an existing `fair-production_postgres_data` Docker volume or an occupied port
443. It does **not** erase anything or automatically resume a partial install:
stop and inspect the host on any failure. It creates a new `fair_platform`
PostgreSQL database and distinct root-owned credentials under
`/etc/fair-production`, with limited runtime and read-only dump roles. The
database, Caddy certificates and configuration survive container restarts. Only
Caddy publishes TCP/443. API/Web/DB are internal. The default is
`FAIR_SHADOW_ENABLED=false`, with no webhook secret mounted, **no real billing,
no Telegram delivery and no synthetic seeding**.

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

The overlay is intentionally not used by `install.sh` or `backup.sh`.
It enables a read-only PasarGuard directory and encrypted second-webhook
ingestion in `SHADOW` only, not payment, balance changes, Telegram delivery or
cutover. Before enabling it, check the seven-day pilot instructions in
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
