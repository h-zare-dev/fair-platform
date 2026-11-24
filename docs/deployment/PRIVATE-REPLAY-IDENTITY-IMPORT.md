# Private 30-day historical identity import — Owner-only Staging runbook

This is **not** a financial operation or cutover. The original identity HMAC
key, source database and raw webhook payloads stay on the legacy server.
Never upload them, the private mapping file, or real historical usernames to
GitHub, ChatGPT, CI artifacts, the public panel or issue comments.

## Prerequisites / human gates

1. Owner reviews, marks Ready and merges the Draft PR. The new migration
   deliberately blocks ordinary Staging deployment until it is reviewed.
   On protected `development`, manually dispatch GitHub Actions workflow
   **Staging private historical identity migration approval (Owner only)**,
   entering `APPROVE_PRIVATE_IDENTITY_STAGE`. The workflow verifies the
   exact candidate migration hash against the accepted manifest and updates
   only root-controlled compatibility metadata; it does not deploy, change
   the database, copy private identities or enable webhook/LIVE accounting.
   Wait for success, then rerun the protected `development` deployment and
   verify its forward-only migration before importing the private sidecar.
2. Verify the existing `replay-30d` still contains **64,135** events and
   the legacy export status is `VERIFIED_SOURCE_REPLAY_MATCH`.
3. Private sidecar is currently on the **legacy** host in a protected
   `private-identity-sidecar-*` directory, with files:
   `PRIVATE-identity-export-result.json` and `PRIVATE-identity-map.jsonl.gz`.
   Neither original exporter script, HMAC key nor the generated full replay
   gzip is needed for this Staging import.
4. The operator securely transfers **only these two private files** to a
   root-controlled Staging directory such as
   `/etc/fair-staging/private-identity`, outside the application repo and
   outside a web-served directory. Avoid terminal commands printing contents.
   Keep permissions restrictive: destination directory 0700, files 0600;
   the migration tooling container runs as UID 1000, which must be able to
   read these files. Do not make them world-readable. Do not add a permanent
   private volume to `owner-api`, `web`, `caddy` or public Compose settings.

## One-shot local CLI on Staging (after owner verification)

Run from `/opt/fair-staging`. The directory mount is **read-only** and exists
only in the single CLI container. The `migrate` tool image uses the privileged
`admin_database_url` secret; the regular public Owner API runtime cannot insert
private mapping rows. Do not print or put database URLs on the command line.

```bash
cd /opt/fair-staging
docker compose --env-file current.env -f compose.yml --profile tools run --rm -T \
  --volume /etc/fair-staging/private-identity:/run/private-identity:ro \
  --env FAIR_SHADOW_ENABLED=true \
  migrate node dist/owner/cli.js import-private-replay-identities \
  /run/private-identity/PRIVATE-identity-export-result.json \
  /run/private-identity/PRIVATE-identity-map.jsonl.gz
```

Expected result is `PRIVATE_IDENTITY_IMPORT` with `status: IMPORTED`,
`billingAdmins: 132` and an explicit count of unmatched archive-admin aliases.
Repeating the same import yields `ALREADY_IMPORTED`; a different digest is
refused with no replacement. A failure must remain failed and must **not** be
worked around by disabling validation, changing financial records, or copying
the HMAC key.

After import, reload `/reports` and check:

- The `historicalSourceIdentity` panel reports import coverage and any
  unmatched pairs; individual admins and operations show original historical
  names **only if that exact archived ID + alias is mapped**.
- Historical original IDs are distinct from `replay-30d` ID keys used for
  filtering. **Current** PasarGuard-directory identity remains unverified.
- Compare before/after SHADOW `chargesToman`, `creditsToman`, `netToman`,
  held counts, operation counts and integrity status for the same `runId`:
  **all must be identical**. Only display identity metadata may change.
- Confirm unauthorized requests cannot read the reports (401), and that no
  upload endpoint for private mappings exists. Weekly Jalali week start/end
  and monthly Persian month labels should remain unchanged.

Keep the two files out of the public application and private workstations not
controlled by the Owner. Host-specific disposal/retention requires the Owner's
explicit operational approval. This process never authorizes LIVE posting,
webhook activation or auto-matching current `primary` admin IDs.
