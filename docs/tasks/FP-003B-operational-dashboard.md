# FP-003B — Temporary Owner Operational Dashboard (DESIGN BRIEF)

**Status:** DRAFT — not an Owner-approved implementation specification. **Next planned stage** after merged FP-003A/FP-001B. Refer to [Canonical Roadmap](../ROADMAP.md).

## Intended outcome

Provide a small, secure, **Owner-only**, read-only operational view of Fair's ingestion and shadow readiness **before** the Pricing and Accounting implementation stages. This is an early visible test interface, not a complete accounting system or a live deployment authorization.

## Candidate MVP — approval required

- A compact Next.js Owner dashboard with four summary **operational** metrics; candidates: received batches, normalized events, unresolved ingestion issues, failed batches. Their exact definitions and time range are not yet frozen.
- Recent normalized events and sanitized ingestion issues with pagination/time bounds, clear status and empty/loading/error states.
- A bounded, read-only NestJS/Fastify API. No raw ciphertext/decrypted payload, secret-bearing fields, private replay manifests or pseudonymized Owner data in responses.
- Clear `SHADOW / NO LIVE BILLING` and **data source** labels, so synthetic/test data is not presented as real live operations.
- Secure Owner-only login/session under `docs/SECURITY_POLICY.md`; scope excludes Owner settings, pricing editing, reports/CSV/Telegram and monetary posting.

## Non-negotiable boundaries

1. FP-003A Testcontainers PostgreSQL instances are disposable and destroyed after replay. FP-003B requires a **separately designed, persistent, isolated, explicitly approved non-production Fair data source**; never assume old replay containers exist or use private historical files by default.
2. No direct connection to Pasarguard/Pasarjew database. No new/upgraded live webhook endpoint until Owner approves source authentication, real HTTP wire contract and delivery safety. A real-data source needs separate Owner authorization, secure retention and privacy review.
3. Authentication/authorization is required for every page/API endpoint. The security policy's preferred approach does not prove it is implemented. No anonymous access, default development bypass or secrets in browser storage.
4. No write operations, financial classifications, ledger posting, schema changes or private operational data in GitHub/CI. Do not put secrets/identifiers in UI fixtures/screenshots/logs.
5. A successful dashboard demo is not production readiness or financial correctness.

## Design decisions to freeze with the Owner

- Access channel: private network/tunnel vs protected HTTPS; TLS, reverse proxy and threat model.
- Exact four KPIs, status semantics, source-vs-receipt timestamps and filtering/window defaults.
- Owner bootstrap, session/CSRF/cookie controls and authorization tests.
- Persistent local/test database seeding, lifecycle, data privacy/retention and truthful source labeling.
- Read-only endpoint contracts, pagination/query bounds, empty/error flows, and UI layout.
- Whether the approved scope includes deployable test stack, and separate live activation gates.

## Draft test / acceptance checklist (NOT an execution grant)

- Unauthenticated and unauthorized requests fail closed; Owner session/logout/CSRF/rate-limit controls work as applicable.
- Safe response allowlists and paginated latest events/issues; four Owner-approved counters correct for synthetic local fixture dataset.
- Distinguishes synthetic/shadow from live; cannot post financial transactions or change Pasarguard.
- Persistent non-production data source, isolated from disposable replay and production systems.
- Test failure/restart/auth/empty states, no secrets, no raw payloads.
- Full frozen install, format, lint, typecheck, unit/integration/E2E, build, Review PASS, QA PASS, CI PASS; only Owner changes PR to Ready and performs Merge.

**Next action:** Owner/ChatGPT review and approve the detailed implementation-grade FP-003B specification first. Do not hand this DRAFT brief to Implementation as approval.
