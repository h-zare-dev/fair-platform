# OD-01 — custom Caddy and PostgreSQL helper decision

**PENDING human Owner decision.** Prior implementation assertions of approval are withdrawn. No independently documented approval reference was supplied. This is a proposal, not authorization. No scan thresholds or waivers changed.

Evidence was freshly obtained on 2026-10-14 using Trivy 0.75.0, linux/amd64, HIGH/CRITICAL filtering. [Sanitized scanner findings](evidence/FP-003B-official-image-scans.json) list exact binary/package/CVE/installed/fixed versions. Only public image metadata and vulnerability fields are retained. These are scanner matches, not exploitability proofs.

| Image | Pinned official digest | Findings |
| --- | --- | --- |
| Caddy 2.11.7 Alpine | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | Four HIGH package matches: x/net 0.59.0 CVE-2026-78669; Go stdlib 1.26.8 CVE-2026-78667, CVE-2026-78669 and CVE-2026-97031. Fixed x/net 0.60.0, Go 1.26.9 / 1.27.2. No CRITICAL matches. |
| PostgreSQL 17.11 Alpine | `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` | gosu binary's Go stdlib 1.24.6: 1 CRITICAL (CVE-2025-68121), 24 HIGH matches. Exact IDs/fixes in JSON. No HIGH/CRITICAL engine or Alpine package matches in this scan. |

Caddy's findings are in its long-running network-facing binary; affected libraries are runtime components. The scanner does not establish whether each vulnerable code path is reachable with this Caddyfile. gosu is a startup privilege-switch helper in the official entrypoint, not the PostgreSQL engine or a long-running network listener. Scanner identification of bundled stdlib does not prove that gosu exercises vulnerable TLS/HTTP paths. It still fails the unchanged scan gate; no waiver is proposed.

Current proposed builds replace only Caddy (`docker/Dockerfile.caddy`, Caddy 2.11.7, Go 1.27.2, x/net 0.60.0) and gosu (`docker/Dockerfile.postgres`, same gosu 1.19 source commit `6456aaa0f3c854d199d0f037f068eb97515b7513`, Go 1.27.2). Official runtime bases/entrypoints and PostgreSQL 17.11 engine remain inherited. Module checksums, toolchain and runtime digests are pinned. Trimpath/build flags reduce variation; bit-identical independent reproducibility has not been demonstrated.

Maintenance burden: monitor Go, x/net, Caddy, 163 locked Caddy modules and gosu dependencies; update locks/toolchain/base digests; rebuild, rerun security and functional tests, review image transitions and publish patched digests. Pinning is not an update service. The human Owner must accept maintenance responsibility or assign it explicitly. Replacing only the helper does not patch future PostgreSQL or OS advisories.

Supported official alternatives checked: fresh pulls of `caddy:2-alpine` and `postgres:17-alpine` resolved to the same pinned baseline digests above. Non-Alpine `caddy:2` (`sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af`) has the same four HIGH binary matches; `postgres:17` (`sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`) has 87 HIGH/CRITICAL package matches including the same gosu stdlib. None of these tested current official variants passes the gate. This is not an exhaustive claim about every upstream tag/platform. Official catalogs: [Caddy](https://hub.docker.com/_/caddy), [PostgreSQL](https://hub.docker.com/_/postgres).

Recommendation: prefer a supported official image when it passes unchanged scans and disposable functional tests. Until such an image is available among the tested alternatives, retaining the minimal binary-only rebuilds is a reasonable **conditional** choice, with explicit human acceptance of both exceptions and patch ownership. Activation stays blocked while that decision is pending. If declined, wait/select suitable supported official digests, rerun verification and remove the custom builds; do not weaken scans.
