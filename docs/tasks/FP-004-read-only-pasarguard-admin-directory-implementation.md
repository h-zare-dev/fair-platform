# FP-004 — read-only PasarGuard admin directory implementation (2026-11-20)

**Owner direction:** The Owner requested connecting their newly created PasarGuard v5.6.0 API key so Fair Platform can choose Billing Admins by name/ID before beginning nightly accounting. On 2026-11-20 they confirmed that additional **read-only** view/list permissions may be retained for future integrations. This task authorizes a reviewable code-only first slice; **it is not authorization to activate host credentials, mutate upstream resources, or turn on accounting**.

## Safe first slice (Draft PR)

- Owner-authenticated `GET /api/v1/owner/directory/admins?search=&offset=&limit=`; server-side only. A fixed configured HTTPS PasarGuard base URL calls the official `GET /api/admins/simple` with `X-Api-Key` and required upstream `admins:read_simple` permission. Use a 3.5-second timeout, no redirects, bounded queries, a 64-KiB body cap, validated response and no raw upstream fields beyond decimal-string `id` and bounded `username`.
- The key is read from an **off-repository mounted file** referenced by `PASARGUARD_API_KEY_FILE`. The optional `PASARGUARD_BASE_URL` and file path are **not set in the first deployment**. The deployment remains functional: the Owner API returns `DIRECTORY_UNAVAILABLE` (503). **Owner UX revision on 2026-11-20:** manual ID entry is removed; Add/Continue actions stay disabled until a real directory is available. The search field remains enabled so the user can retry. No upstream requests occur without provisioned configuration.
- Group membership and direct-admin package exception dialogs have a searchable, paginated `username (ID)` picker, with no manual-ID entry. Numeric ID remains the source-scoped authority; stale/unknown IDs already assigned remain visible numerically. Group history, package prices, membership semantics, financial events and webhook processing are unchanged.
- Mock contract tests cover authentication, query caps, response sanitization, duplicate/invalid IDs, empty pages, denied scope, oversized upstream response, network failure, redirects and missing credentials; browser test uses synthetic interception only, including disabled actions when unavailable. No real upstream API, key, production accounts, traffic or financial data in CI/tests.

## Secret and release boundary

The Owner has stored `PASARGUARD_API_KEY` in protected GitHub **Staging Environment secrets**. This is safe as a *provisioning input*, but **does not automatically supply a running container**. Do not add its plaintext to source, `current.env`, Docker image layers, logs, GitHub artifacts or browser JavaScript. Do not pass the raw secret as a Compose environment variable: container process environment is inspectable by privileged host users.

**Separate Owner-approved operations are required before a live read-only lookup can succeed:**

1. Verify the actual PasarGuard v5.6.0 key has `admins:read_simple`, that the live server supports `GET /api/admins/simple`, and review **all** `8 resources / 11 actions` to establish that any retained additional privileges are genuinely read-only. The Owner's later screenshots showed `Settings - Update settings` and `HWIDs - Delete` enabled inside the Modify API Key form; **neither is read-only**. Do not activate this key unless the Owner removes those grants, saves, and verifies the effective permissions. If any key action writes or deletes, replace it with a read-only key before provisioning.
2. Prepare a second, exact Staging Compose diff: only `owner-api` obtains `PASARGUARD_BASE_URL=https://pasar.fairinternet98.com`, `PASARGUARD_API_KEY_FILE=/run/secrets/pasarguard_api_key`, and a new file-backed Compose secret for that service. Do not mount it in `web`, migration, smoke, backup or PostgreSQL containers. The host secrets location remains root controlled (`SECRETS_DIR`), with the secret never committed.
3. Provision the key to the host secret file through a single protected **Owner-only** operation using the existing GitHub Environment secret; no CLI echo, shell tracing, artifact or workflow log of the secret. Read-only verify file presence/permissions without displaying contents.
4. As this necessarily changes the accepted host Compose hash, use the **separate operator-approved config baseline gate**. Do not bypass `CONFIG_REQUIRES_OPERATOR_UPGRADE` or migration/image provenance protections. Normal CI auto-deploy cannot safely approve its own Compose change.

## Staging activation implementation (2026-11-20; Owner merge/dispatch pending)

The Owner has since stated that the excessive API-key grants were removed. The
workflow does **not** introspect the granted scope list; Owner remains
responsible for preserving the least-privileged `admins:read_simple` key.

- The new reviewed `docker/staging/compose.yml` adds the exact PasarGuard HTTPS
  base URL and file path to **`owner-api` only**. No key is placed in the GitHub
  repository, Compose environment, JavaScript bundle, image or database.
- The protected Owner-only GitHub Action
  `.github/workflows/staging-pasarguard-directory-activation.yml` consumes the
  existing **`staging-bootstrap` Environment secret `PASARGUARD_API_KEY`**.
  It transfers the secret through pinned SSH stdin into a root-owned file at
  `/etc/fair-staging/secrets/pasarguard_api_key`, then approves **only** the
  exact byte-for-byte Compose additions and updates the accepted config hash.
  The host secrets directory is `0700`. Because `owner-api` runs as the
  non-root `node` user and Compose file-based secrets are bind mounts, the
  mounted secret source is `0444` inside the private host directory; **only**
  `owner-api` mounts it. A `0400` source would prevent the running Node process
  from reading the key.
- **Before any host write**, the operator requires an HTTPS-only, no-redirect
  authenticated **GET** to `/api/admins/simple?offset=0&limit=1`, with a
  bounded response shape. Denied permissions, bad shape, empty source, network
  failure or expired key fail closed without installing the secret or changing
  the accepted host config. Tests never send any real key or request.
- The operator checks the accepted deployment manifest, protected branch tip,
  descent from the last deployment, current PostgreSQL identity, resolved
  journal and exact Compose delta. It does **not** migrate, change images,
  restart services, alter webhooks or perform financial accounting. Failed
  local config validation restores the original manifest and Compose and
  removes only the newly installed secret.

**Owner steps after reviewing and merging this PR:**

1. The normal post-merge `development` **Deploy may initially fail** with
   `CONFIG_REQUIRES_OPERATOR_UPGRADE`: that is the intentional safe config
   acceptance gate, not proof that the app is connected.
2. Open GitHub **Actions → Staging PasarGuard read-only admin directory
   activation (Owner only) → Run workflow**. Choose `development` and type
   exactly `ACTIVATE_PASARGUARD_ADMIN_DIRECTORY`. This runs using the protected
   Environment's already provisioned secret; **do not paste any key into a
   workflow input or chat**.
3. After the Action is green, open the most recent protected `development` CI
   run and **Re-run failed jobs** (specifically `deploy`). This ordinary deploy
   is still responsible for image checks, migration preflight, health, smoke
   and rollback. The operator Action by itself does not put new code on server.
4. Sign in at `https://panel.fairisfair.ir/settings/groups`, open a group's
   **مدیران گروه** dialog and verify usernames/IDs really appear. Test search
   and page navigation; record only outcome/status, never any API token or
   private directory dump. A continued `DIRECTORY_UNAVAILABLE` needs a
   read-only, code-specific investigation, not a manually typed admin ID.

Rotation of a provisioned key is deliberately **not** silently enabled by this
one-time activation (it rejects an existing file). If the key expires later,
use a separate explicit Owner-approved rotation procedure with the same
non-disclosure and rollback protections.
5. After the Owner explicitly approves, verify the HTTPS Owner login, first page and a searched admin, cache-control/no secrets in browser, and both unavailable/manual-ID behavior and the known-good rollback procedure. Still no live financial posting or PasarGuard writes.

**Non-goals:** Admin group import from PasarGuard, data from users/subscriptions, key editing through the Owner UI, in-browser upstream access, events, billing, Telegram reports, real accounting and production deployment. No active autonomous agents.

## Review evidence

- Upstream source: [`PasarGuard/panel/app/routers/admin.py`](https://github.com/PasarGuard/panel/blob/main/app/routers/admin.py), [`app/models/admin.py`](https://github.com/PasarGuard/panel/blob/main/app/models/admin.py), [`app/routers/authentication.py`](https://github.com/PasarGuard/panel/blob/main/app/routers/authentication.py); confirm against the actual v5.6.0 deployment before activation.
- Design background: [FP-004 Owner UI admin directory and timezone](FP-004-owner-ui-admin-directory-and-timezone.md), [CURRENT_STATE_AND_POLICY](../CURRENT_STATE_AND_POLICY_2026-11-19.md).

Only the human Owner marks the PR Ready or merges. A merged code-only PR does **not** imply the live directory is configured.
