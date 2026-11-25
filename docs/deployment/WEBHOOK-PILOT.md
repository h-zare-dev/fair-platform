# Second webhook and one-week SHADOW pilot

## Release to the existing test host

After the Owner merges into protected development, CI verifies the merge,
publishes the scanned images and deploys their digests to Staging. The webhook
settings and dashboard changes use the existing receiver route, mounted
webhook secret and database schema. The nightly review tables and report view require the shadow review migration approval below. Verify Deploy succeeded before opening
Settings → Initialization to copy the address and secret. If the host has
never provisioned the receiver, follow the original FP-005 provisioning
procedure before adding the second destination.

## Smoke on the existing test host

Preserve the first destination. Configure the second destination and its independent secret using the [FP-005 operator procedure](../tasks/FP-005-STAGING-SHADOW-TEST.md). Capture the UTC start on Test-Bot before generating one or two known test events:

```sh
since=$(date -u +%FT%TZ)
```

On the test host with the reviewed repository checked out, compare the read-only output against the known action, account and billing admin in PasarGuard:

```sh
docker exec -i fair-staging-postgres-1 psql -X -v ON_ERROR_STOP=1 \
  -U fair_migrator -d fair_staging -v since="$since" \
  < scripts/staging/check-webhook-pilot.sql
```

Check receipt at both destinations, normalization, original billing admin and a retry without a second charge. Empty results do not prove delivery. The archive section separately compares received children, unique events and occurrence counts in the same database snapshot.

## Starting clean

After accepting the smoke, choose the target host. Use a newly initialized database and the reviewed migrations. Provision Owner access, encryption key, separate webhook secret, source settings, tariff assignments and group history for that database. Rehearse access and ingestion before the seven-day observation begins. Preserve the old database until the Owner identifies the exact obsolete database and authorizes disposal. Record the UTC boundary and local business date. Start continuous intake before baselining, reconcile changes during the scan and verify the opening import causes zero charges. Events already present at the legacy destination provide a comparison across the handover.

## Nightly acceptance

Compare each local date and billing admin with the legacy bot, including bytes, charge, credit, held operations and late arrivals. Verify a Reset and its proven Update form one renewal at the final package price in either arrival order. Exercise restart, missed night and redelivery. Confirm a stable opening snapshot predates any increase that needs it. Changes without a provable earlier limit go to review.

## Ambiguity decision

Hold the affected admin/day. Present the contributing event IDs, source timestamps, account, package changes and eligible pairings. Where the evidence establishes one operation, the Owner records the selected IDs, reason and decision timestamp. Unresolved cases remain pending; a missing source fact must not be replaced with a guessed amount. Recompute a held day once against its original tariffs; retain the decision and publish the resulting daily, weekly and monthly totals. A review records the selected event IDs, catalog package, price, volume and decision time in one transaction.

### Seven-day parallel run

Keep the existing PasarGuard destination active and add the Staging URL as its
second destination. Keep SHADOW enabled for seven full local days. The end of
the observation window does not enable delivery. Verify receipt on the dashboard
with a controlled account before starting the window.

At night, open Accounting ambiguities to inspect confirmed bytes and Toman for
each admin and original local day. Select ambiguous events from the same account
and day, then choose one catalog package for the selection or mark it without
financial effect. Review the original day's subtotal after saving. A pending day
for one admin does not block other admins or dates. Record any discrepancy with
the existing bot during the seven-day comparison. Telegram delivery is a later
Owner decision.

After publishing, use the protected Staging shadow review approval with
`APPROVE_SHADOW_REVIEW_STAGE` for the additive migration, then rerun the
protected development deployment. Verify the day report and review controls
before starting the seven-day observation.
