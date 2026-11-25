# Historical SHADOW archive and reports

An Owner-staged export supplies the complete date range in one import. Every
archive has its own immutable input identity and never appends to the previous
30-day archive or the operational source. The SHADOW calculation uses the
approved fixed catalog, the existing 600-second source-time correlation, and
the configured deletion-credit policy. Completed runs remain selectable on
`/reports`.

## Export and import

1. On the legacy host, export the original webhook fields for the desired window.
   The exporter preserves PasarGuard IDs and usernames for billing admins,
   accounts and actors. It reads the legacy database in read-only mode and
   includes the fields needed by replay. Subscription URLs, proxy credentials
   and arbitrary raw payload fields are excluded. The files contain real names
   and belong in a private directory outside Git.

   The four full Jalali months Mordad–Aban 1405 span 122 days in Asia/Tehran.
   The start is `2026-07-22T20:30:00Z` and the exclusive cutoff is
   `2026-11-21T20:30:00Z`.

   ```sh
   python3 scripts/replay/export-source-archive.py \
     --days 122 --cutoff 2026-11-21T20:30:00+00:00 \
     --output-dir /root/fair-source-replay
   ```

   Run the exporter separately for any earlier report window that still needs
   the original IDs. Use that archive's actual receipt cutoff and duration.
   Keep the original export and its manifest paired during the private transfer.

2. After Owner merge and CI Publish, run **Staging source archive identity
   migration approval (Owner only)** on protected `development` with
   `APPROVE_SOURCE_ARCHIVE_IDENTITY_STAGE`. It approves the exact migration
   that records the identity mode for each archive. Rerun the failed Deploy
   job for that same commit and verify it succeeded before importing.

   On Staging, place the new matched gzip and manifest in a private operator
   directory readable by the one-shot migration container's UID. From
   `/opt/fair-staging`, substitute the actual filename printed by the exporter:

   ```sh
   docker compose --env-file current.env -f compose.yml --profile tools \
     run --rm --no-deps -T \
     -e FAIR_SHADOW_ENABLED=true \
     -e FAIR_TIME_ZONE=Asia/Tehran \
     -v /private/archive:/private/archive:ro \
     migrate node dist/owner/cli.js import-replay-archive \
     /private/archive/pasarjew-source-122d-REPLACE_WITH_SHA256.jsonl.gz
   ```

3. The command validates the gzip checksum, record totals and receipt window,
   imports through the encrypted inbox and queues a SHADOW run. The existing
   processor normalizes the archive before the journal finishes. Refresh
   Reports to select the new completed run. The archive interval, by receipt
   date, determines whether a full week or month is covered. Billing chronology
   uses each event's preserved source timestamp. The fixed catalog is an
   Owner-attested historical simulation assumption.

   The archive supports up to 100,000 batches and 400,000 child occurrences.
   Retry the same command with the same input after an interruption. In
   particular, if queueing failed before the catalog was ready, the already
   imported archive is reused. A normalized occurrence-count mismatch fails the
   run and appears in the advanced tool as
   `REPLAY_SHADOW_ARCHIVE_EVENT_COUNT_MISMATCH`.

Daily, weekly and monthly statements show sold package volume next to the
amount. Volume sums the bytes of recorded charge entries from the same ready
days as the money subtotal. A deletion credit is a money adjustment and does
not reduce the gross volume. When the period is incomplete, the volume is
labeled as the subtotal of ready days.

## Approved manual operations without a confirmed price

The Owner can review individual archive rows in the Ambiguities tab and put
their `review:` keys in an optional sibling `.review.json` file, a JSON array of
strings. The import command automatically reads the companion file. For a new
export, use the current run's keys if the source anonymization or evidence has
changed. For unchanged source evidence and aliases, a key can be reused in an
overlapping window. An unrecognized review key fails the new calculation.

Approved operations are listed in the manual tab with source evidence and no
amount. A priced operation on the same day can be recorded if no other genuine
hold remains. Normal verified monthly resets are processed by the ordinary
calculator. Manager names alone never approve an operation.

The new import creates an independent SHADOW run. The normalized events store
the original IDs and usernames, and the calculator and report filters use those
IDs. Reports defaults to a completed source-webhook run when available. Check
the matching window, receipt and event counts, ledger totals, held operations
and a few known PasarGuard IDs before relying on the new report. Review keys
include source IDs and must be regenerated from the new evidence.

Older pseudonymized runs remain selectable under their legacy label for audit.
They are immutable and are replaced for reporting by re-exporting and replaying
each required window. The import does not run against live balances.

A simultaneous matching renewal gets a review marker in Transactions. Confirm
the two source event pairs before drawing a conclusion about whether both
transactions are genuine.
