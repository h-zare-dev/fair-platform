# Domain and Accounting Rules

This document is the authoritative source for v1.0 business/accounting semantics. Agents and implementation code must not reinterpret these rules. **Status distinction:** existing FP-002 ledger and FP-004 quote engine have *not* yet implemented the later, Owner-approved 2026-11-19 nightly/group rules below. Those rules supersede the **target** of old immediate financial posting/system-default/version-heavy UI, but require future milestone-specific implementation approval and safe forward-only migrations. See [current-state record](CURRENT_STATE_AND_POLICY_2026-11-19.md) and [approved design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md).

## Terminology
- **CHARGE**: increases the amount owed by a Pasarguard admin.
- **CREDIT/REFUND**: decreases the amount owed.
- **Billing Admin**: financial owner of the user/event.
- **Actor Admin**: admin/person who performed the operation.

## Money
- Canonical unit: **Toman**.
- Store integer Toman amounts as `BIGINT`-compatible values.
- Never use floating point for money.
- No Rial or multi-currency in v1.0.
- Use exact integer/rational arithmetic. **FP-004 Owner-approved decision (2026-11-18): round the final positive fractional Toman outcome upward (CEIL) once**, never round billable byte quantities or use floating-point money.

## Traffic
- Canonical normalized unit: bytes (`BIGINT`).
- Preserve Pasarguard raw values without rounding in integration data.
- UI/report presentation must use **GiB (گیگابایت) only**, never TB; persist exact source bytes without premature rounding.
- FP-002's currently approved billing/display basis is **1 GiB = 1,073,741,824 bytes**. Quantities may be fractional GiB; preserve integer bytes without whole-GiB rounding. This supersedes an earlier decimal-GB proposal.

## Pricing Modes
### Per-GB
Bill the billable traffic delta using the configured rate.

### Fixed
Existing FP-004 synthetic quote lookup is exact by bytes only. The **approved future fixed-package billing contract** matches an atomic fixed package by **exact `(package_bytes, duration_days)`**, independent of whether a Pasarguard Template was used. Unknown required duration or an unmatched manual 50-GiB/25-day **fixed-package** entry is an accounting exception, not a guess. In an explicitly chosen per-GiB-only rule the verified charge is byte-based rather than a guessed fixed-duration package.

### Mixed
The **historical FP-004 synthetic-only engine** tries a fixed byte-count lookup first and falls back to per-GiB **inside the selected rule only**. The newly approved target uses **either fixed packages or per-GiB for a group's applicable period**, not mixed fallback between price tiers. Do not interpret the old engine as authorized nightly biller.

### Pricing Precedence — approved future accounting
1. **Direct Billing Admin exception**, where explicitly assigned.
2. **The Billing Admin's one Fair-local group** and that group's applicable packages or per-GiB rate.
3. **No system default tariff.** Missing pricing must become an exception.

The preexisting FP-004 quote-only engine still has `ADMIN_OVERRIDE > ASSIGNED_PLAN > DEFAULT_PLAN` until the new system is implemented. No new financial posting may reuse that legacy fallback. Packages are reusable, price-locked after assignment, copied instead of version-edited, and carry **no validity dates**. Only admin/group **assignments** carry optional Jalali start/end dates; selected end is **inclusive**, internally UTC half-open. The start cannot be edited after assignment; changing the end cannot reprice finalized or frozen pending dates. Store exact pricing provenance in financial records.

## Local groups and accounting day (Owner-approved 2026-11-19; not implemented)
- Groups belong to Fair Platform only; Pasarguard's group/inbound hierarchy is not imported. An admin is in **at most one** local group at a time. The UI only adds, removes or transfers an admin; separate append-only membership history records entered/left timestamps and actors, without editable membership date controls.
- **The admin's local group at the end of the business day** determines the tariff for *all* that admin's billable operations of that day. A mistaken morning group corrected before local midnight is not used. A real intra-day transfer also changes the whole day's group tariff; this deliberate consequence is visible in membership history. Preserve the end-of-day context so a late nightly job or a two-day exception delay cannot accidentally use today's group for yesterday.
- The business date is Jalali in configurable `FAIR_TIME_ZONE` (initially `Asia/Tehran`), with local midnight `[start,end)` stored as UTC instants. Calendar day length must not be hardcoded as 24h. Settlement runtime, default lateness allowance ~10 minutes and timezone are independently configurable.
- **Do not calculate a financial price or post a ledger charge during the day.** Ingest and normalize source events immediately and idempotently, but perform operation classification, correction/correlation and pricing only at the **nightly** settlement for each `(source, Billing Admin, local date)`.
- If a day has a financially blocking exception, **hold only that admin/day's report**. Other days for the same admin, and other admins, may finalize and send normally. On resolution, use the original day's frozen context; finalize and send the delayed daily report separately. Weekly/monthly totals wait until every constituent day is finalized and sum only **immutable daily ledger amounts**; never reprice delivered or finalized results.

## Missing Pricing
Never assume zero and never guess. Create `PRICING_MISSING` and route it to Accounting Exceptions.

## Unlimited
Unsupported in v1.0. Unexpected unlimited state creates `UNEXPECTED_UNLIMITED`; no automatic 100GB fallback exists.

## Create
### Active
Create a full-package **billable operation**; determine and post its price **at nightly settlement**, not immediately at webhook receipt. Verified same-day corrections are reconciled before posting. Never silently waive a genuine additional sale.

### On Hold
Create a full-package **billable operation**; determine and post its price **at nightly settlement**. On-hold versus active does not by itself change what is billable.

## Update-Only Increase
Charge only the positive data-limit increase.

Example: `50GB → 100GB` means a billable increase of 50GB.

For fixed pricing, the increase itself is priced as a package. If the delta package is missing, create `PRICING_MISSING`. In mixed mode, missing fixed delta falls back to per-GB.

## Update-Only Decrease
No refund in v1.0.

Example: `100GB → 50GB` without reset has financial effect `0`.

## Manual Usage Reset
A usage reset with no package change charges the full current package again.

## Reset + Update
Correlate into **one renewal transaction** whose billable traffic is the final package.

Examples:
- `100GB + RESET + UPDATE→50GB` → one renewal, billable 50GB.
- `50GB + RESET + UPDATE→100GB` → one renewal, billable 100GB.

Do not represent these as separate charge/refund transactions.

## Automatic Reset Strategy
Configuring `data_limit_reset_strategy` does not itself create a charge. When the automatic reset actually occurs, charge the full resulting/current package.

A real monthly/automatic reset may have missing/null human Actor identity. Actor absence alone must not discard a valid event or force individual manual approval; the Billing Admin remains the debtor. Actual operation, final package, correlation, pricing and financial idempotency still must be verified.

## Next Plan
Defining a Next Plan does not create a charge. When Next Plan actually activates and Pasarguard applies/reset to the resulting plan, charge that resulting package.

Do not infer activation or resulting-package values from unverified non-null `next_plan` fields or an action label alone. Verified normal activations should be charged automatically without per-event Owner approval.

## Delete
No refund merely because an account was deleted; preserve the audit event. **Before nightly finality**, a Create/Delete/Recreate sequence may be treated as a correction **only when verified stable identity and source semantics prove it**, otherwise raise `AMBIGUOUS_CORRECTION` for review. Deletion alone cannot silently cancel a genuine charge. Once finalized, never mutate historical ledger/report amounts.

## Auto Delete
Pasarguard may delete expired/limited users automatically. Classify/audit the event but financial effect remains `0`.

## Admin Transfer
Historical accounting transactions remain with the **Pasarguard Billing Admin** that owned the user/event at verified source time. Actual user transfer between Billing Admins changes ownership for future operations, with no retroactive refund/recharge. **This is distinct from changing a Billing Admin's Fair-local pricing group**, for which the Owner approved the whole-day end-of-day group selection above.

## Actor vs Billing Admin
Store both concepts separately when available. The actor may be Owner/operator while the financial debtor is the user's Billing Admin.

## Correlation
- Use stable user identity, not username alone.
- Use source event timestamps (`enqueued_at` or equivalent), not HTTP receive time.
- Correlation must be order-independent and state-aware.
- Default correlation window: **600 seconds** (Owner correction 2026-11-23;
  1–600 seconds configurable). This bounds source-event candidates, **not**
  HTTP/webhook delivery latency or the nightly accounting cutoff.
- The correlation window is an **Owner-configurable setting**, not a hard-coded constant.
- Time proximity alone never proves one operation. For the approved read-only
  FP-006/007 archive preview, use consecutive source-timeline alternating
  Update/Reset chains and distinct adjacent pairs even when the same account
  has multiple renewals that day; unmatched odd/non-alternating chains fail
  closed. A Reset carrying the verified *old* duration may be followed by an
  Update carrying the *new* duration: charge once at the final exact package
  if that transition is proven. See the 2026-11-23 task spec; this is **not**
  authorization to post financial charges or activate nightly settlement.
- Beyond the configured window, do not auto-correlate; create `AMBIGUOUS_CORRELATION` if necessary.
- A generic zero-delta update must not be paired as a package change merely because it is close in time to a reset.

## Repeated Update-Only Changes
Each positive increase is independently billable. Update-only decreases remain non-refundable in v1.0.

## Missing Previous State
Missing previous state must never silently become `delta=0`. Create `PREVIOUS_STATE_MISSING` / Accounting Exception unless the event is otherwise deterministically interpretable.

## Accounting Exceptions
At minimum:
- `PRICING_MISSING`
- `UNEXPECTED_UNLIMITED`
- `PREVIOUS_STATE_MISSING`
- `AMBIGUOUS_CORRELATION`
- `UNKNOWN_WEBHOOK_EVENT`

v1.1+ may add reconciliation-specific exceptions.

For nightly billing also require typed, audited cases for missing verified package duration, ambiguous correction, overlapping pricing assignment, and late-after-finalized events. Do not silently price zero. The existing `accounting_exceptions.status='OPEN'` database constraint requires a future forward-only migration to support reviewed resolutions; this text is **not** evidence it is implemented.

## Ledger
Financial transactions and finalized daily report snapshots are **immutable**. New charges are posted only at the nightly admin/date close, atomically with exact source-event linkage, pricing context, daily total and outbox obligation. Corrections to an already finalized period require **separate explicit, Owner-approved adjustment accounting** rather than rewriting/deleting historical financial records; that adjustment workflow is **not yet authorized/implemented**.

## Reporting Source
Daily reports originate from the **stored, finalized accounting transactions and immutable daily snapshots**, never raw webhooks. Weekly/monthly reports aggregate only those finalized per-day financial amounts for their Jalali periods; an unresolved date blocks only the aggregate(s) that include it. A later daily report may be sent even while an earlier daily report is held. No recalculation of amounts based on current groups or rates.
