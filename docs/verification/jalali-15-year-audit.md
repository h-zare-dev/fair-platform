# Jalali calendar: 15-year exhaustive date-conversion audit

## Scope and source of truth

- **Library:** pinned `jalaali-js@2.0.1`, invoked through the pure `@fair-platform/calendar` package.
- **Independent daily oracle:** the `persian` calendar supplied by Node.js ICU, not the implementation being tested.
- **Published calendar anchors:** the Nowruz dates and leap-year indicators for Solar Hijri years **1390–1406**, transcribed from the Iranian calendar reference [1206–1498](https://calendar.ut.ac.ir/documents/2139738/7092644/Kabise+Shamsi+1206-1498.pdf) via [Roozbeh Pournader's transcription](https://github.com/roozbehp/persiancalendar/blob/main/kabise.txt).
- **Daily sample:** **5,480 consecutive Gregorian days**, 2011-11-19 to 2026-11-19 inclusive (15 years to the verification date).
- **Additional month boundaries:** every Jalali month in **1390–1405** (192 month periods).
- **Particular regressions:** all Shahrivar 31 → Mehr 1 boundaries, all Esfand 29/30 → Farvardin 1 boundaries, especially 1403/12/30 ↔ 2025-03-20, and invalid dates that must be rejected.

## Test invariant

For every day in the sample:

1. The result of Gregorian → Jalali equals independently computed ICU calendar fields.
2. Jalali → Gregorian returns precisely the original Gregorian civil date.
3. No Jalali day repeats, and successive Jalali dates strictly increase.
4. Every individual Jalali month covers exactly its advertised number of civil days; adjacent month boundaries share the same **exclusive end / inclusive start** date without gaps.

These tests are deliberately deterministic: no external HTTP request is needed at runtime, and the date range is fixed rather than based on the machine clock.

## Verified locally, 2026-11-19

| Check | Result |
| --- | --- |
| Exhaustive 5,480-day ICU comparison and round trips | PASS |
| Published Nowruz/leap-year anchors, 1390–1406 | PASS (17 years) |
| All Shahrivar 31 boundaries, 1390–1405 | PASS (16 boundaries) |
| All Esfand/Farvardin boundaries, 1390–1405 | PASS (16 boundaries) |
| Month-length and contiguous boundary checks, 1390–1405 | PASS (192 months) |
| Invalid Gregorian and Jalali date rejection | PASS |
| Calendar-specific Vitest suite | PASS (22 tests) |
| Full Vitest unit suite | PASS (497 tests across 9 files) |
| Calendar and test TypeScript checks | PASS |
| ESLint and Prettier on changed source/test files | PASS |

Test runtime: Node.js **24.22.3**, ICU **78.3**, pnpm **12.6.0**. A future runtime/library upgrade must rerun these tests before release.

## Reproduce

From the repository root using the project's declared Node/pnpm toolchain:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @fair-platform/calendar typecheck
corepack pnpm exec vitest run tests/unit/calendar.test.ts
corepack pnpm exec vitest run tests/unit
```

## Important non-claims

- The evidence covers the specified years and published anchors, **not every possible historical or future year**.
- This package currently converts **civil dates only**; it does not interpret instants or generate UTC report-period boundaries. The approved `Asia/Tehran` half-open report-period implementation and historical DST tests remain a separate integration step.
- This audit does not modify financial posting, pricing, existing timestamps, the staging host, or production.
