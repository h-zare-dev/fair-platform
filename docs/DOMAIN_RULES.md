# Domain and Accounting Rules

This document is the authoritative source for v1.0 business/accounting semantics. Agents and implementation code must not reinterpret these rules.

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

## Traffic
- Canonical normalized unit: bytes (`BIGINT`).
- Preserve Pasarguard raw values without rounding in integration data.
- UI/report presentation may format GB/TB.

## Pricing Modes
### Per-GB
Bill the billable traffic delta using the configured rate.

### Fixed
Exact fixed package price lookup.

### Mixed
Try fixed package lookup first; if no exact package exists, fall back to per-GB pricing.

### Pricing Precedence
1. Admin override.
2. Assigned Pricing Plan.
3. Default Pricing Plan.

Pricing is effective-dated. Financial transactions store the pricing rule/version used.

## Missing Pricing
Never assume zero and never guess. Create `PRICING_MISSING` and route it to Accounting Exceptions.

## Unlimited
Unsupported in v1.0. Unexpected unlimited state creates `UNEXPECTED_UNLIMITED`; no automatic 100GB fallback exists.

## Create
### Active
Charge the full created package immediately.

### On Hold
Charge the full created package immediately. On-hold versus active does not change billing.

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

## Next Plan
Defining a Next Plan does not create a charge. When Next Plan actually activates and Pasarguard applies/reset to the resulting plan, charge that resulting package.

## Delete
No refund in v1.0. Preserve an audit event with financial effect `0`.

## Auto Delete
Pasarguard may delete expired/limited users automatically. Classify/audit the event but financial effect remains `0`.

## Admin Transfer
Historical accounting transactions remain with the admin that owned them at transaction time. From transfer time forward, new financial effects belong to the new Billing Admin. No retroactive refund/recharge/reassignment.

## Actor vs Billing Admin
Store both concepts separately when available. The actor may be Owner/operator while the financial debtor is the user's Billing Admin.

## Correlation
- Use stable user identity, not username alone.
- Use source event timestamps (`enqueued_at` or equivalent), not HTTP receive time.
- Correlation must be order-independent and state-aware.
- Default correlation window: **120 seconds**.
- The correlation window is an **Owner-configurable setting**, not a hard-coded constant.
- `<=30s` may be treated as high-confidence operationally; `30s–configured-window` remains eligible when state semantics match.
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

## Ledger
Financial transactions are immutable wherever feasible. Corrections use explicit adjustment transactions rather than rewriting/deleting historical financial records.

## Reporting Source
Reports aggregate Accounting Transactions only.
