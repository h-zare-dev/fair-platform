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
