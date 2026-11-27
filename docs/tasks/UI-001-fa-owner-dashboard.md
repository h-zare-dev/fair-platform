# UI-001 — Persian Owner Staging Dashboard, Themes, and GiB Presentation

**Owner direction:** Requested explicitly on 2026-11-18 in the Fair Platform conversation after FP-004 staging acceptance. UI-only change on a dedicated Draft PR; Owner remains the only person authorized to Ready/Merge.

## Approved scope and boundaries

- Translate all current Owner-facing pages (sign-in, authenticated dashboard, operational event/issue lists and FP-004 pricing controls) into Persian, including safe errors, empty states, navigation and status labels; declare `lang="fa" dir="rtl"`.
- Make the layouts visually polished, keyboard-accessible, and responsive down to mobile widths, with horizontal scrolling for wide tabular data instead of body overflow.
- Provide a light/dark theme button on both login and dashboard. Persist only this non-sensitive UI preference; leave authentication, CSRF, and Owner authorization unchanged.
- Replace user-entered raw traffic bytes with **GiB** inputs. `50` must send `53687091200` exact bytes to the *unchanged* FP-004 API; a structured fixed-package row with size `50` and price `150000` must produce `{ "53687091200": "150000" }`. The interface accepts Persian/Arabic digit forms, preserves exact integer Toman, rejects fractions that cannot map to integral bytes, rejects zero/negative/overflow values, and does not use JavaScript floating-point money or traffic conversion.
- Show read-only normalized-event limits, fixed package catalogs and synthetic quote quantities in GiB. Clearly mark approximate presentation where an integer byte value has no finite 6-digit GiB decimal representation. Keep UTC source instants and stable technical identifiers intact.
- Preserve `SHADOW`/synthetic/Owner-only security notices and the no-live-financial-posting boundary. No data migration, API schema change, new billing rule, webhook activation, production connection or report-aggregation change.

## Acceptance

1. Every current web page is RTL/Persian; theme toggles on both pages and survives reload (or works without local-storage access).
2. Desktop, mobile and tablet layouts have usable controls; tables scroll internally; keyboard focus is visible.
3. 50 GiB, 1.5 GiB and Persian digits convert exactly; a tenth GiB and malformed/duplicate fixed entries reject with Persian messages; pricing API receives only decimal byte strings and exact Toman strings.
4. The event listing and fixed-catalog history show GiB, not raw bytes. Synthetic quote result still records no charge.
5. Web typecheck/build, unit tests and applicable staging browser/UI tests pass; human Owner verifies layout and conversion after protected-development merge and automatic staging deployment.

## Not included

Package duration/cap enforcement, billing classification, report generation and live charging are outside this UI request and require their own Owner-approved specs.
