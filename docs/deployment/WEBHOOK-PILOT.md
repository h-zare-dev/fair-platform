# Second webhook and one-week SHADOW pilot

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

Compare each local date and billing admin with the legacy bot, including bytes, charge, credit, held operations and late arrivals. Verify a Reset and its proven Update form one renewal at the final package price in either arrival order. Exercise restart, missed night and redelivery. The nightly Create path still needs the Update/Reset classifier and a verified opening watermark before the pilot can accept daily financial results.

## Ambiguity decision

Hold the affected admin/day. Present the contributing event IDs, source timestamps, account, package changes and eligible pairings. Where the evidence establishes one operation, the Owner records the selected IDs, reason and decision timestamp. Unresolved cases remain pending; a missing source fact must not be replaced with a guessed amount. Recompute a held day once against its original tariffs; retain the decision and publish the resulting daily, weekly and monthly totals. This decision workflow remains implementation work.
