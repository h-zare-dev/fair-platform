# Production host candidate — Owner-controlled installation (SHADOW OFF)

**Status:** Owner-controlled host installation tools. The previous Test-Bot
panel at `panel.fairisfair.ir` must remain untouched. CI does not attest the
production host.
No live financial billing or production CD is authorized. Review the commit
and await all four `development` images and CI before installing a new release.

## One installer for first installation, safe updates and hostname changes

Run as root on a dedicated amd64 Ubuntu console/SSH terminal **after the Owner
merges the reviewed PR, production CI is green, and its images are published**.
The same downloaded script supports `install`, `update`, `host` and `directory`.
Without an argument it shows a menu on existing installations. Download and
inspect it before executing:

```bash
curl -fsSLo /root/fair-platform-install.sh https://raw.githubusercontent.com/h-zare-dev/fair-platform/development/scripts/production/bootstrap.sh && bash /root/fair-platform-install.sh
```

For explicit actions (after the script has been downloaded):

```bash
bash /root/fair-platform-install.sh install  # Only a completely new host
bash /root/fair-platform-install.sh update   # Existing installation; preserve database
bash /root/fair-platform-install.sh host     # Change configured DNS name, IPv4 or localhost
```

The installer asks permission to install missing Ubuntu Docker prerequisites.
On a **new host**, it fetches only production Compose/scripts with a sparse Git
checkout (not application source), asks for the access host (DNS, IPv4 or
`localhost` for tunneling), shows the reviewed SHA, asks for the ACME email,
pins immutable GHCR images, provisions secrets, installs the UI, and
prompts for the one-time Owner password with **hidden terminal input**.
It then offers optional **read-only** PasarGuard admin directory configuration:
HTTPS base URL and a hidden API key prompt. The key is stored exclusively at
`/etc/fair-production/secrets/pasarguard_api_key`, UID 1000, mode 0600; it
never enters Compose YAML, `release.env`, shell history or logs.

On an **already installed host** with `/etc/fair-production/installed`, choose
`update`. The script retrieves only the release metadata, production Compose
and deployment scripts into a versioned directory (no app source checkout on
the host). It pins verified new API/Web/Caddy digests, keeps the **existing
immutable PostgreSQL image and database volume**, automatically creates and
checks a local database dump, then asks for explicit approval before rolling
the application containers. It retains the previous Compose bundle and image
pins and attempts application rollback if the new containers fail health checks.
Owner credentials, optional directory config and all database contents persist;
no Owner re-bootstrap or Shadow activation is performed.

The update deliberately refuses a release changing PostgreSQL, database
migrations/connection setup or runtime SQL grants. Such a release requires a
separately reviewed forward-migration/restore plan; pretending app rollback
could undo SQL changes would be unsafe. The update is not unattended CD.
An initial update of the old `292cc3d3...` release can set `site.env` via a
single hostname/IP prompt. Subsequent updates reuse it without asking again.
The directory config remains in `/etc/fair-production/directory.env`.

Prerequisites: SSH key/console, SSH and TCP/443 firewall allowance, free port
443 on fresh installs, and, for a DNS hostname, a DNS-only A record resolving
to this server with no unexpected AAAA record. Caddy uses 443 (no 80).
Preserve Test-Bot, its private archive and identity imports. If GHCR requires
authentication, perform private `docker login ghcr.io` with a read-only token.
`resolve-release.sh` checks image source/revision and immutable digests;
`install.sh` refuses existing volumes, occupied port 443 or partial installs.
SHADOW, real billing, Telegram delivery and synthetic seeding remain OFF.

### Hostnames and IP addresses are configuration, not code

The production Owner API is **not bound to `panel.fairisfair.ir`**. The
interactive installer writes one root-owned `0600` endpoint setting:

```ini
# /etc/fair-production/site.env (example only)
OWNER_HOST=panel.example.com
```

The same setting configures both Caddy's TLS site name and the Owner API's
**strict** `https://...` browser origin. It is **not** an open-origin mode:
arbitrary `Origin`/`Host` headers remain untrusted. The immutable four image
digests stay in the separate `release.env` and do not change with the host.
To change an already-supported installation later, run only:

```bash
bash /root/fair-platform-install.sh host
```

The command validates the new hostname/IPv4, asks for confirmation and
recreates only `owner-api` and Caddy. If the restart fails, it restores the
previous host configuration and retries the previous services. No code edit,
image pull, DB migration, volume reset, secret rotation or PR is involved.

**Important for previously installed hosts:** the original pinned
`292cc3d3...` Owner API image still hardcodes `panel.fairisfair.ir`.
Use `update` first, then `host` for future address changes. The update
does not destroy the installed database, change Shadow or require source edits.
Merely fetching newer scripts or changing DNS does not update running images.

For regular browser access, a public DNS hostname pointing at the server is
recommended: Caddy obtains/renews trusted HTTPS certificates automatically.
`https://203.0.113.10` (documentation-only IP) and `https://localhost` are
also valid configured origins, but Caddy normally gives IP/localhost an
**internal-CA certificate**;
remote browsers do not trust that CA unless the operator explicitly installs
its trust root. `localhost` from your laptop means your **laptop**, not the
remote server; use an SSH tunnel for local access. Never submit Owner passwords
over untrusted plaintext HTTP. TCP/443 still needs to be reachable.

Health and service check (read-only):

```sh
ACTIVE=$(cat /etc/fair-production/active-bundle)
docker compose --env-file /etc/fair-production/release.env --env-file /etc/fair-production/site.env -f "$ACTIVE/docker/production/compose.yml" ps
curl --fail --show-error https://panel.example.com/health/ready
```

## Optional later: Owner-authorized second webhook SHADOW pilot only

This is a separate **human activation**, not part of first install. Finish
authentication and zero-charge smoke checks first; retain the legacy webhook
destination. Provision a separate, read-only PasarGuard API key on the host as
`/etc/fair-production/secrets/pasarguard_api_key`, owned by UID 1000 and mode
0600, from a trusted non-logged channel. Configure the private upstream
`PASARGUARD_BASE_URL` in `/etc/fair-production/directory.env` using the
interactive installer's `directory` action; there is no shared default.
Never put the API key in shell history. The `shadow_webhook_secret` was
randomly generated in the first-install secret
directory; configure it in PasarGuard as the independent **second** webhook
secret without exposing it in chat or a repo. Then, after explicit Owner signoff:

```sh
cd /opt/fair-platform
docker compose --env-file /etc/fair-production/release.env --env-file /etc/fair-production/site.env --env-file /etc/fair-production/directory.env \
  -f docker/production/compose.yml -f docker/production/compose.shadow.yml config --quiet
docker compose --env-file /etc/fair-production/release.env --env-file /etc/fair-production/site.env --env-file /etc/fair-production/directory.env \
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

Use the public installer with `update` for schema-stable application releases.
It obtains new immutable API/Web/Caddy digests while preserving the existing
PostgreSQL digest; it must not substitute a database image or silently migrate
the schema. Owner reviews the release SHA and approves the update in an
interactive session. The local pre-update dump is not a substitute for a
verified off-host copy/restore. DB-changing releases require separate Owner
approval and an explicit forward-only migration plan. Never borrow Staging's
no-backup/privileged-password SSH and auto-deploy exceptions.

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
