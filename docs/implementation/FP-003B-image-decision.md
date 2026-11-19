# OD-01 — custom Caddy and PostgreSQL helper decision

**Historical OD-01 comparison evidence, captured 2026-10-14.** The Owner
**did approve the two custom-image exceptions in conversation**: the
[decision was relayed to PR #36](https://github.com/h-zare-dev/fair-platform/pull/36#issuecomment-6168437966)
and [acknowledged in re-review](https://github.com/h-zare-dev/fair-platform/pull/36#issuecomment-6168662738).
That relay is not an Owner-authored GitHub comment. **Current code uses Caddy
2.11.9**, not the Caddy 2.11.7 scanned here; CI builds/scans custom Caddy and
PostgreSQL gosu-helper images and uses immutable digests in release proposals.
The tables below remain a dated baseline, not up-to-date Trivy results. The
[2026-11-19 disposition](../security/STAGING_IMAGE_AND_ADVISORY_DECISION_2026-11-19.md)
reconfirms **synthetic-Staging-only** retention with unchanged scans and human
maintenance ownership; it does not attest the current host digest.

Evidence was freshly obtained on 2026-10-14 using Trivy 0.75.0, linux/amd64, HIGH/CRITICAL filtering. [Sanitized scanner findings](evidence/FP-003B-official-image-scans.json) list exact binary/package/CVE/installed/fixed versions. Only public image metadata and vulnerability fields are retained. These are scanner matches, not exploitability proofs.

| Image | Pinned official digest | Findings |
| --- | --- | --- |
| Caddy 2.11.7 Alpine | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | Four HIGH package matches: x/net 0.59.0 CVE-2026-78669; Go stdlib 1.26.8 CVE-2026-78667, CVE-2026-78669 and CVE-2026-97031. Fixed x/net 0.60.0, Go 1.26.9 / 1.27.2. No CRITICAL matches. |
| PostgreSQL 17.11 Alpine | `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` | gosu binary's Go stdlib 1.24.6: 1 CRITICAL (CVE-2025-68121), 24 HIGH matches. Exact IDs/fixes in JSON. No HIGH/CRITICAL engine or Alpine package matches in this scan. |

Caddy's findings are in its long-running network-facing binary; affected libraries are runtime components. The scanner does not establish whether each vulnerable code path is reachable with this Caddyfile. gosu is a startup privilege-switch helper in the official entrypoint, not the PostgreSQL engine or a long-running network listener. Scanner identification of bundled stdlib does not prove that gosu exercises vulnerable TLS/HTTP paths. It still fails the unchanged scan gate; no waiver is proposed.

The **originally proposed** October builds replaced only Caddy (then 2.11.7, Go 1.27.2 and x/net 0.60.0) and gosu (same gosu 1.19 source commit `6456aaa0f3c854d199d0f037f068eb97515b7513`, then Go 1.27.2). **Current Dockerfiles instead use Go 1.27.3 and Caddy 2.11.9.** Official runtime bases/entrypoints and PostgreSQL 17.11 engine remain inherited. Module checksums, toolchain and runtime digests are pinned. Trimpath/build flags reduce variation; bit-identical independent reproducibility has not been demonstrated.

Maintenance burden: monitor Go, x/net, Caddy, 163 locked Caddy modules and gosu dependencies; update locks/toolchain/base digests; rebuild, rerun security and functional tests, review image transitions and publish patched digests. Pinning is not an update service. The human Owner must accept maintenance responsibility or assign it explicitly. Replacing only the helper does not patch future PostgreSQL or OS advisories.

Supported official alternatives checked: fresh pulls of `caddy:2-alpine` and `postgres:17-alpine` resolved to the same pinned baseline digests above. Non-Alpine `caddy:2` (`sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af`) has the same four HIGH binary matches; `postgres:17` (`sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`) has 87 HIGH/CRITICAL package matches including the same gosu stdlib. None of these tested current official variants passes the gate. This is not an exhaustive claim about every upstream tag/platform. Official catalogs: [Caddy](https://hub.docker.com/_/caddy), [PostgreSQL](https://hub.docker.com/_/postgres).

**Disposition updated 2026-11-19:** prefer a supported official image when it passes unchanged scans and disposable functional tests. For the **currently deployed synthetic-only Staging design**, retain the minimal binary rebuilds under the [new Owner-directed decision](../security/STAGING_IMAGE_AND_ADVISORY_DECISION_2026-11-19.md); the old October approval gate is no longer pending. Runtime rollout and image updates still require their normal distinct gates; do not weaken scans.
