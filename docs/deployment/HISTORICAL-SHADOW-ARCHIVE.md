# Historical SHADOW archive and reports

An Owner-staged export supplies the complete date range in one import. Every
archive has its own immutable input identity and never appends to the previous
30-day archive or the operational source. The SHADOW calculation uses the
approved fixed catalog, the existing 600-second source-time correlation, and
the configured deletion-credit policy. Completed runs remain selectable on
`/reports`.

## Export and import

1. On the legacy host, use the same private replay exporter and anonymization
   configuration used for the previous archive. A rolling 90-day import and
   four complete Jalali months are different windows. In Asia/Tehran the
   complete Mordad–Aban 1405 window is 122 days, from
   `2026-07-22T20:30:00Z` through the exclusive cutoff
   `2026-11-21T20:30:00Z`. For the previously reviewed exporter with a
   positional `days` argument and a constant `CUTOFF`, the wrapper substitutes
   those two parameters in a disposable copy and keeps the original exporter.

   ```sh
   python3 scripts/replay/export-legacy-window.py --source /root/fair_replay_export.py \
     --days 122 --cutoff 2026-11-21T20:30:00+00:00
   ```

2. Stage the resulting matching `.jsonl.gz` and `.manifest.json` in a private
   directory outside Git. After the Owner reviews and deploys the
   `replay-archive` additive migration through the existing Staging approval
   process, invoke the import from a trusted operator shell on Staging.
   The example assumes the files are readable by the one-shot container user.

   ```sh
   docker compose --env-file current.env -f compose.yml run --rm --no-deps -T \
     -e FAIR_SHADOW_ENABLED=true \
     -e FAIR_TIME_ZONE=Asia/Tehran \
     -v /private/archive:/private/archive:ro \
     migrate node dist/owner/cli.js import-replay-archive \
     /private/archive/pasarjew-replay-122d.jsonl.gz
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

When the export uses the same anonymization configuration, Reports uses the
existing private identity import to display historical names for exact matches
of role, archived ID and archived username. Coverage counts are calculated
against the selected archive. Managers absent from the private mapping, and
changed aliases without an exact match, remain marked as unverified. The
mapping establishes historical names only.

A simultaneous matching renewal gets a review marker in Transactions. Confirm
the two source event pairs before drawing a conclusion about whether both
transactions are genuine.
