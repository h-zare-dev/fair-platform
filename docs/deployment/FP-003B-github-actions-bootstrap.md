# One-time Ubuntu 26.04 test VPS bootstrap through GitHub Actions

This is a **manual GitHub Actions workflow**, not the normal automatic deployment on pushes to `development`. It installs Docker, Compose and UFW, starts the existing pinned/published Caddy/Web/Owner API/PostgreSQL images, applies additive database migrations and runtime grants, and verifies public HTTPS. It **does not** create an Owner, seed events, connect to Pasarguard, change Cloudflare, or activate normal delivery.

## GitHub Secrets

Create the environment `staging-bootstrap` in Settings → Environments. Under its **Secrets**, add:

- `STAGING_BOOTSTRAP_HOST`: the disposable Ubuntu 26.04 server IPv4 address.
- `STAGING_BOOTSTRAP_ROOT_PASSWORD`: the current temporary root SSH password. Never enter it into workflow inputs, repository variables, chat or code.
- `STAGING_BOOTSTRAP_HOSTKEY_SHA256`: an **independently verified** SHA256 fingerprint of the VPS's Ed25519 SSH **host** public key (format `SHA256:...`). Verify via your provider's console/trusted provisioning data; never accept an unverified network scan. Without a correct value, the workflow fails **before sending a password**.
- `STAGING_ACME_EMAIL`: the Let's Encrypt contact email for Caddy.

The existing Cloudflare DNS-only A record for `panel.fairisfair.ir` must resolve to this IP. No Cloudflare API is used or needed; remove any stale AAAA separately. Public TCP/443 must be reachable for Caddy's TLS-ALPN certificate issuance.

## Launch

After the PR containing this workflow is reviewed and Owner-merged into `development`, choose Actions → **First staging VPS bootstrap (Owner only)** → Run workflow on `development`, and enter `BOOTSTRAP_TEST_VPS`.

The job verifies exact GHCR images matching the current development commit, their OCI labels and digest references, validates DNS and the pinned SSH host key, then connects with the root password over SSH TCP/22. It installs Docker Engine and Compose, enables UFW with inbound TCP/22 and TCP/443, generates database credentials on the VPS, applies migrations/least-privilege runtime grants, and brings up PostgreSQL, API, Web and Caddy.

This requires a **fresh, isolated, amd64 Ubuntu 26.04 VPS** with password-based root SSH access already enabled and no existing Docker containers. It refuses an existing accepted staging install. Failed or partial installations must be reconciled; do not delete the PostgreSQL data merely to retry. Root password login is **temporary for this disposable test**, not the final key-only staging security goal.

Run success means `https://panel.fairisfair.ir/login` responds with a public trusted certificate. With no Owner, the dashboard is intentionally inaccessible until the human Owner later invokes the existing password-protected **interactive CLI** in a trusted terminal. There are no demonstration records: after Owner creation, cards and lists should be empty.

## Intentionally disabled

- No Owner creation, synthetic seed, financial actions, live webhooks or Pasarguard data.
- No Cloudflare credentials, DNS modification or HTTP port 80.
- No normal staging auto-deploy activation, deploy SSH key, off-host backup or pretend restore acceptance. Existing protected automatic delivery stays default-off until its separate Owner-authorized configuration and acceptance tests.
- No unattended staging server teardown.

This workflow is a **first installation only**. It does not replace the later protected GHCR → SSH release/update and rollback flow, which still requires a separate restricted deploy key and verified off-host backups.
