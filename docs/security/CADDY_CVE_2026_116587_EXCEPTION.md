# Temporary risk acceptance: Caddy / go-jose v3 / CVE-2026-116587

Status: **OPEN / ACCEPTED FOR SUPERVISED NON-PRODUCTION DEVELOPMENT ONLY**
First recorded: 2026-11-15
Automatic exception expiry: **2026-12-15**
Tracked by: Issue #56 and Draft PR #55
Severity: HIGH (CVSS 7.5; RSA JWK CPU-exhaustion denial of service)
Advisory: https://github.com/advisories/GHSA-mgcc-cww5-fp2q

## Verified facts
- Trivy source scan flags `github.com/go-jose/go-jose/v3@v3.0.5`, built transitively from `github.com/caddyserver/caddy/v2@v2.11.9` through Smallstep PKI.
- As of 2026-11-15, GitHub's advisory lists **no patched v3 release**. The `v4.1.6` patch does **not** fix imports of v3.
- The current `docker/staging/Caddyfile` configures public ACME TLS, request limits, security headers, and reverse proxy routing. It does not configure a JWK-upload or JWK-parsing endpoint.
- The dependency is present in the Caddy build. **We have not demonstrated that untrusted JWK parsing is unreachable under all conditions. This is an accepted residual risk, not a VEX `not_affected` finding.**
- Earlier attempts to upgrade Smallstep crypto to drop v3 hit incompatible Caddy certificate APIs; a working patched replacement is not established.
- Revisit immediately if Caddy, Smallstep, or go-jose/v3 gets a supported security release, or if any public JWK parsing path is identified.

## Exception scope
Only `.github/security/caddy-go-jose-v3-temporary-exception.yaml` contains this decision:
- Exactly `CVE-2026-116587`, with package URL pinned to `pkg:golang/github.com/go-jose/go-jose/v3@v3.0.5`.
- Trivy loads it explicitly on **source filesystem** scan and **Caddy image** scan.
- All API, Web, and PostgreSQL image security scans continue WITHOUT this exemption.
- All other HIGH/CRITICAL vulnerability findings and secret scanning remain blocking.
- Trivy's `expired_at: 2026-12-15` makes the finding blocking again after expiry.
- A green Trivy job with this file means **passing after a documented exception**, not that the vulnerable dependency is fixed.

## Strict authorization boundaries
This acceptance is limited to preparing Draft PR #55 for Owner review, with no public production or customer deployment authorization. It does NOT override independent QA, the separate Containers job, protected-branch rules, the Owner-only Merge gate, or the separate Lab activation approval. No merge or deployment is executed by this change.

## Exit criteria
1. Replace the dependency with a supported patched and Caddy-compatible upstream release.
2. Demonstrate the built Caddy image/binary no longer contains the vulnerable v3 path, and test public ACME issuance/renewal, TLS and reverse-proxy behavior.
3. Remove the explicit `trivyignores` settings and delete the exception YAML; rerun unfiltered source and all four container scans.
4. Review this exception **by 2026-12-15** even if the upstream patch remains unavailable. Do not extend it automatically.

## Separate CI issue
The previously failing Containers `Browser acceptance on local synthetic containers` step surfaced a Docker test name ending in `-`, generated from a temporary directory ending in `_`. This is a distinct release-test harness bug, corrected in `tests/release/test_compose.py`; its fix must pass on a new exact-head run.
