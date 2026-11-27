# FP-004 — Card-based Owner Settings (2026-11-20)

**Scope:** Owner-approved Staging UI redesign of the existing Phase A catalog. This does not enable nightly accounting, upstream Pasarguard credentials, Telegram reporting, live financial posting, or production.

## Navigation and interactions

- `/dashboard` is the operational overview only (received batches, events and errors). Catalog forms and the legacy versioned pricing editor no longer clutter it.
- `/settings/packages` is a responsive package card grid. Each package displays its **GiB volume, integer duration days and Toman price** with **Copy package**, edit-if-never-assigned and **Assignments/expiration** actions. Copy creates a distinct package identity with a new name/price. All actions use accessible dialogs.
- `/settings/groups` is a separate group card grid. Each card manages its current Admin members (add/transfer, remove, list), group package assignments (fixed package or per-GiB price, Jalali start/end), group membership history, and safe group deletion. Individual Admin exceptions are available in a secondary area and retain precedence over group prices.
- All Owner catalog UI labels say **package**, not tariff. No numbered wizard steps, UTC timestamp fields, editable assignment starts, or package-level validity periods are shown.
- **Expiration is an assignment field, not a package field.** The package-card expiration action lists its assignments; the group-card action shows assignments to that group. Only assignment end dates can be changed under the existing PostgreSQL closed-day/overlap guards; starts remain immutable.
- The currently unapproved Pasarguard Admin directory is **not** connected. Admin IDs remain manual with a clear disclosure; no new upstream credentials or direct DB access are introduced.

## Fractional GiB

Decimal GiB is accepted (including `0.5` and `0.2`) with Persian/Arabic digits. Canonical stored and matched volumes remain **integer bytes**. Since `0.2 × 2^30` is not an integer, the UI rounds to the nearest byte (at most **0.5 byte** error), then persists those bytes. Editing a pre-assignment package renders enough fractional digits to round-trip the original integer byte value. Pricing and reporting remain integer-byte based; display remains GiB only.

## Safe group deletion and Staging release gate

Deleting a group with **any existing members, membership audit history, or price assignments** is forbidden. The new Owner API checks these conditions in a transaction and the `OwnerSafeGroupDelete1791400000000` migration adds an independent PostgreSQL `BEFORE DELETE` guard and grants only the necessary delete privilege to the existing Owner runtime role. Historical group identity cannot be erased through the Owner UI.

This migration **cannot** be auto-approved by an ordinary merge; the Staging deploy intentionally fails closed at migration compatibility preflight until the human Owner approves this exact migration. Do not repeatedly rerun CI before approval:

1. After personally reviewing and merging the PR into protected `development`, check that Quality, Security, Containers and Publish are green. Deploy may show `MIGRATION_COMPATIBILITY_UNPROVEN` before any schema/app change.
2. On GitHub Actions run **Staging FP-004 safe group deletion migration approval (Owner only)** on `development`, with exact input `APPROVE_FP004_GROUP_DELETE`. It compares accepted and candidate migration proofs, enforces identical Compose bytes and database identity, and updates only the root-owned migration compatibility metadata. It performs **no DB migration or restart**.
3. Require `STAGING_GROUP_DELETE_MIGRATION_APPROVED`. Only then rerun **the failed Deploy job of the latest protected-branch CI run**. Verify `STAGING_SMOKE_OK` and `STAGING_RELEASE_OK` before manually testing the two new Settings routes.
4. A failed approval is a stop condition: inspect the specific guard code, use Owner-only diagnostics; never edit migration hashes or disable security gates manually.

Following this one-time additive migration acceptance, **UI-only merges require no new operator approval** under the existing fast-release policy. The migration's `down()` exists for disposable CI databases only, not for Staging rollback.

## Follow-up: assignment expiration and Owner feedback (2026-11-20)

- **Do not delete an assignment.** “Removing access” and setting a final validity date must not erase price history. The existing **Change end date** dialog is the only current action. Its PostgreSQL trigger continues to reject overlapping ranges and edits to closed periods; starts and package prices stay immutable.
- Group/package cards and direct-Admin exception lists show **current and future** assignments. Assignments whose exclusive UTC end instant has arrived disappear from the current list automatically and remain accessible under the collapsed **Expired history** panel. An inclusive local Jalali end remains visible through the full final date. Server-returned `effectiveUntil` is used for this comparison, never the browser's local timezone; history and data are preserved.
- Synthetic data isolation remains unchanged. The previously prominent `source_instance_id` selector moves to a disclosed **Advanced / about synthetic environment** section at the bottom of Settings. `synthetic` is a test source ID, not a real Pasarguard connection. Advanced switching is retained for isolated historical test data.
- Successful writes use a dismissible, accessible animated toast that disappears after **20 seconds**, with a countdown strip. Errors remain visible until fixed; no timer hides critical errors.
- The displayed IANA timezone comes from the Owner API's validated `FAIR_TIME_ZONE` configuration (default `Asia/Tehran`), not a hardcoded UI timezone. Changing the server ENV requires a service restart; old assignments keep their originally saved `time_zone` and UTC boundaries.
- This follow-up is **UI plus read-only API projection and friendly error mapping**. No database migration, financial calculation, source credential activation, backup policy change or new Owner migration approval is required.
