# Agent visibility and upstream Caddy/JOSE blocker

**Tracking:** #53 (Orchestrator bootstrap), #56 (security), Draft PR #55.
**State:** blocked from unattended/Lab activation until CI and required real gates pass.

## Why CI remains red (confirmed 2026-11-14)

The previous Next.js and Zod high/critical advisories were resolved in PR #55; GitHub's `pnpm audit --prod --audit-level high` and `quality` completed successfully at head `31dd2cf63d83b21c10e56479325069499059b76d`.

GitHub's **source Trivy security scan** and **Caddy container Trivy scan** independently detect **CVE-2026-116587** (GHSA-mgcc-cww5-fp2q), a HIGH-severity RSA JWK CPU-exhaustion/DoS issue in `github.com/go-jose/go-jose/v3@v3.0.5`. GitHub's advisory lists **no patched v3 release**; updating `go-jose/v4` does **not** fix simultaneous imports of v3.

The transitive dependency enters the Caddy binary via upstream modules:

```text
docker/caddy/main.go
  -> github.com/caddyserver/caddy/v2/modules/standard
    -> github.com/caddyserver/caddy/v2/modules/caddypki
       -> github.com/smallstep/certificates v0.30.2
          -> github.com/go-jose/go-jose/v3
    -> github.com/caddyserver/caddy/v2/modules/caddytls
       -> internalissuer.go -> caddypki -> Smallstep
```

The source path and the Go module requirements were checked against Caddy `v2.11.9`, Smallstep certificates `v0.30.2` and Smallstep crypto `v0.91.0`. The Caddyfile currently uses public ACME, reverse proxy, request body limits and response headers; do **not** assume that disabling the PKI module or replacing the JOSE major module is compatible with the ACME and TLS implementation. There is no supported one-line replacement confirmed.

**Do not** disable Trivy, add `.trivyignore`, fabricate a VEX/not-affected declaration, or mark this gate PASS based on successful Next.js tests.

### Remediation acceptance

1. Prefer a new upstream Caddy/Smallstep version which no longer compiles `go-jose/v3`, once it actually exists and has a verifiable release/digest.
2. Any alternative must include a demonstrably patched and maintained v3 implementation with independent code/security review and confirmed Caddy/Smallstep compatibility; this requires separate Owner architecture/security approval. Major-version module replacement without compatibility evidence is prohibited.
3. Record the exact `go mod why -m github.com/go-jose/go-jose/v3` output in the review report and verify the *built* Caddy binary/image and source lockfiles; `go list -m` alone is insufficient evidence of linked runtime reachability.
4. Retest Caddyfile adaptation, ACME issuance/renewal, TLS 1.2/1.3 negotiation, reverse proxy routing, headers, Owner authentication, synthetic browser E2E and all four Docker image Trivy scans.
5. Require successful **quality**, **security**, and **containers** GitHub checks bound to the **same exact PR head SHA** before any gate advances. A passing quality job alone is insufficient.
6. Keep PR #55 Draft, `labActivated=false`, no production access, no merge or unattended service until the human Owner approves activation after full acceptance.

Primary advisory: https://github.com/advisories/GHSA-mgcc-cww5-fp2q

## View the local agent state without using Codex tokens

A read-only CLI is implemented in `scripts/orchestrator/status.ts`. It never reads a GitHub token, calls Codex, runs an SSH command or activates the orchestrator.

In a local checkout containing the PR #55 head:

```bash
pnpm exec tsc -p scripts/orchestrator/tsconfig.json
node scripts/orchestrator/dist/status.js
node scripts/orchestrator/dist/status.js --json
watch -n 3 node scripts/orchestrator/dist/status.js
```

The default state path is `~/.local/state/fair-platform/task.json` and the model config is `~/.local/bin/fair-agent-models.conf`; either can be overridden with positional arguments.

This CLI displays configured Sol/Luna roles, last verified gate outcomes, the exact shortened SHA, phase, attempt count and reworks. A persisted `inFlight` checkpoint is marked **IN_FLIGHT_UNVERIFIED**, not RUNNING: after a power loss it may outlive the actual Codex process. **It is a state-file viewer, not a live process-health monitor.** The service/timer and real Lab gates are not installed or activated.

Until first approved task execution there may be no task state file, in which case status correctly says `NOT_STARTED`. Manual `tmux` agents are not orchestrator-owned and are intentionally not misrepresented by the state snapshot.

## Real readiness checklist

- [x] Dedicated local SSH alias and pinned host key verified by the Owner (`fair-lab`).
- [x] Shared Sol/Luna launcher role config prepared on the Owner's laptop (reported by Implementation).
- [x] Durable TypeScript orchestration and simulated failure/recovery tests in Draft PR #55.
- [x] Read-only status snapshot, plus fail-closed all-three-CI gate check in this branch.
- [ ] GitHub quality/security/containers all green on one exact head.
- [ ] Independent Review and QA after all changes.
- [ ] Supervised live Codex/GitHub task approval and permission acceptance test.
- [ ] Real pinned Lab deploy, synthetic PasarGuard + Telegram E2E and rollback.
- [ ] A separate explicit Owner activation decision; only the Owner marks PR Ready/merges.
