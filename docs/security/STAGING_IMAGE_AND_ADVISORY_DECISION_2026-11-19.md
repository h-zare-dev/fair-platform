# Staging image and temporary-advisory review — 2026-11-19

**Status:** Owner-directed disposition for **disposable, synthetic-only Staging**.
The Owner authorized resolving outstanding documentation mismatches on
2026-11-19 and delegated the least-disruptive approach. **Existing October
approval evidence was located:** the Owner's 2026-10-14 decision was [relayed
in PR #36](https://github.com/h-zare-dev/fair-platform/pull/36#issuecomment-6168437966),
with a subsequent [independent implementation re-review](https://github.com/h-zare-dev/fair-platform/pull/36#issuecomment-6168662738).
The relay **does not claim to be a comment personally posted by the Owner**.
This newer disposition reconfirms retention of that design and its maintenance
constraints, **not** production approval or a new live host security scan.

## OD-01: explicit current disposition

**Decision: RETAIN the two existing minimal custom image builds for this Staging
environment; do not revert to the older official image digests.** The October
Owner-relayed approval already covered both replacements for Staging only;
the historic
2026-10-14 official Caddy 2.11.7 and PostgreSQL 17.11 image scans documented
HIGH/CRITICAL toolchain/helper findings. The current build uses Caddy **2.11.9**
and rebuilds its binary, and uses the official PostgreSQL 17.11 runtime with a
rebuilt `gosu` helper. Those changes are already represented by
`docker/Dockerfile.caddy` and `docker/Dockerfile.postgres`; this document does
not make, reproduce or attest a new image build.

This approval is **limited to retaining that reviewed design on disposable
Staging**. Its continuing conditions are:

1. Immutable pinned base digests, checked-in Go modules/checksums, the existing
   four-image HIGH/CRITICAL scans, SBOM/publish and protected-merge gates remain
   mandatory. No blanket vulnerability exclusion or security-gate bypass.
2. Treat every updated upstream base, Go toolchain, Caddy module or `gosu`
   component as a fresh image decision with PR/CI evidence; no silent image
   substitution. Prefer a newly verified safe official image if one later
   satisfies the same gates and release behavior.
3. **Maintenance owner:** the human repository Owner reviews the CI/security
   results and authorizes image changes through the normal PR process; nobody
   has delegated unattended patching/merging rights. A Staging image waiver
   never authorizes an equivalent waiver for live financial production.
4. Public HTTPS, Owner authentication, restricted request paths, migrations,
   health checks, compatible app rollback and synthetic-only isolation are
   independently mandatory. The exact deployed VPS image digest is **unknown
   from repository documents** and needs live diagnostic evidence if claimed.

The historical [OD-01 comparison](../implementation/FP-003B-image-decision.md)
remains evidence of *why* the replacements were selected, not proof that its old
scanner output describes today's rebuilt binaries.

## Advisory reassessment (official upstream sources, 2026-11-19)

| Finding | Verified upstream status | Actual exposure | Current disposition |
| --- | --- | --- | --- |
| `CVE-2026-112366` — `picomatch@4.0.7` | [GitHub GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was **withdrawn on 2026-11-18**, but [NVD CVE-2026-112366](https://nvd.nist.gov/vuln/detail/CVE-2026-112366) remains published; no supported fixed release is established. A withdrawn package advisory is **not a patch**. | Dev tooling **and production API image** through TypeORM→tinyglobby. No public untrusted-glob input has been demonstrated; full exploit-path unreachability is not proved. | Keep exactly scoped, time-bounded source/API Trivy exceptions **through 2026-12-02**, with risk limited to synthetic Staging. Review scanner behavior and upstream resolution before then. |
| `CVE-2026-116587` — `go-jose/v3@3.0.5` | [Upstream GHSA-mgcc-cww5-fp2q](https://github.com/go-jose/go-jose/security/advisories/GHSA-mgcc-cww5-fp2q) lists **no patched v3**; v4.1.6 is fixed but is not a drop-in v3 dependency fix. | Transitive Caddy/Smallstep dependency; configured Staging Caddyfile does not expose a JWK import endpoint, but not all runtime paths have been proven unreachable. | Keep exactly scoped source/Caddy Trivy exception **through 2026-12-15**; reject broad waivers and continue monitoring compatible Caddy/Smallstep fixes. |

**Important:** Both findings remain **unpatched residual risks**, accepted for
the existing disposable synthetic Staging only until their published deadlines.
This is risk disposition, **not technical vulnerability closure**. The Trivy
`expired_at` gates are automatic for the specific YAML entries; CI must fail
closed on an expired finding, not silently extend it. The separate
`pnpm-workspace.yaml` `audit.ignore` entry has **no expiry enforcement** and
must be checked manually, even if GitHub's withdrawn GHSA no longer affects
`pnpm audit` in a particular CI run.

### Action required at the deadlines

- **By 2026-12-02:** review upstream Picomatch fix/advisory status, run fresh
  `pnpm audit`, Trivy source and production API image scans without the
  Picomatch exceptions, inspect TypeORM/tinyglobby's actual glob sources, and
  remove `audit.ignore` plus both Trivy exceptions once verification succeeds.
  If still vulnerable and no fixed compatible dependency exists, **do not
  silently extend the expiry**; block the next affected deployment and obtain
  a separately recorded Owner decision.
- **By 2026-12-15:** re-evaluate Caddy/Smallstep and `go-jose/v3` resolution
  using current module graph and vulnerability scans. Remove the source and
  Caddy-image exception after a verified compatible fix. If v3 is still
  unpatched, **block the next affected deployment unless the Owner records
  a new explicit, time-bounded risk decision**.
- The Owner's cancellation of autonomous development agents means **there is
  no unattended agent assigned to do these checks**. The human Owner and any
  explicitly engaged assistant/developer handle them during normal PR review.
  This document does not create a background reminder or change CI schedules.

## Non-goals of this documentation PR

- No change to runtime images, lockfiles, pnpm audit ignore, Trivy exception
  matching/expiry, CI job definitions, protected branches or deployments.
- No claim that the advisories are fixed, that security scanners have
  passed on this PR, or that new live host diagnostics were performed.
- No reactivation of autonomous agents, queue polling or lab bootstrap.
