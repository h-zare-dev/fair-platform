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
5. After the Owner explicitly approves, verify the HTTPS Owner login, first page and a searched admin, cache-control/no secrets in browser, and both unavailable/manual-ID behavior and the known-good rollback procedure. Still no live financial posting or PasarGuard writes.

**Non-goals:** Admin group import from PasarGuard, data from users/subscriptions, key editing through the Owner UI, in-browser upstream access, events, billing, Telegram reports, real accounting and production deployment. No active autonomous agents.

## Review evidence

- Upstream source: [`PasarGuard/panel/app/routers/admin.py`](https://github.com/PasarGuard/panel/blob/main/app/routers/admin.py), [`app/models/admin.py`](https://github.com/PasarGuard/panel/blob/main/app/models/admin.py), [`app/routers/authentication.py`](https://github.com/PasarGuard/panel/blob/main/app/routers/authentication.py); confirm against the actual v5.6.0 deployment before activation.
- Design background: [FP-004 Owner UI admin directory and timezone](FP-004-owner-ui-admin-directory-and-timezone.md), [CURRENT_STATE_AND_POLICY](../CURRENT_STATE_AND_POLICY_2026-11-19.md).

Only the human Owner marks the PR Ready or merges. A merged code-only PR does **not** imply the live directory is configured.
