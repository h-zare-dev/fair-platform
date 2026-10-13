# FP-003B Documentation Alignment Audit — 2026-10-13

**Status:** Documentation proposal review; no implementation, infrastructure changes or live verification performed. Basis: `development` SHA `ff39bd7a08aa0569c9cb409f8e0642d80a22356e`, Owner design decisions in this project and repo-controlled contracts. **This document does not constitute Owner implementation approval.**

## Decisive requirements reconciled

- Next milestone remains **FP-003B**, not FP-007. Later order remains FP-004 Pricing → FP-005 Create Charges → FP-006 Baselines/Updates → FP-007 Reset/Correlation/Next Plan.
- Public address **https://panel.fairisfair.ir**; Cloudflare **DNS-only**; no private VPN/SSH tunnel requirement for normal browsing. Web app public internet reachable but data **requires Owner authentication**.
- Dockerized **Caddy** with public TCP/443 and automated ACME **TLS-ALPN-01**; public TCP/80 and UDP/443 not required; only TCP/22 additional public inbound for SSH key-only management/deployment.
- Simple **UFW** now, no custom Docker firewall rules; explicitly account for Docker's published-port/UFW interaction by **never publishing Web/API/Postgres ports**. Test actual IPv4/IPv6 reachability.
- One Owner via secure **CLI bootstrap**; no public registration/account creation/password recovery. Auth sessions server-side with Argon2id, expiry, logout/revocation, CSRF and brute-force protection.
- **Full post-merge STAGING CI/CD**: GitHub Actions after **human Owner merge into protected development** → quality/security → pinned GHCR image digest → dedicated SSH staging deploy → compatible migrations → health/smoke → safe conditional app rollback. No automatic merging, no PR deployment secrets or self-hosted public PR runner. One-time bootstrap/go-live approval still required.
- Staging VPS, persistent PostgreSQL and synthetic data are separate from private historical replay, production Pasarguard DB and the later financial production stack. Owner API cannot bypass unverified webhook authentication or write to the ledger.

## Documents updated as needed

- `docs/tasks/FP-003B-operational-dashboard.md`: replace obsolete private-channel design brief with full, **still unapproved** implementation proposal, endpoints, exact time/count semantics and acceptance tests.
- `docs/deployment/FP-003B-staging-runbook.md` (new): deployment prerequisites, full pipeline, backup/restore, operations and recovery.
- `docs/adr/0015-public-https-staging-and-controlled-delivery.md` (new): record major scope/network/delivery decision.
- `docs/ROADMAP.md`, `PROJECT_BLUEPRINT.md`, `ARCHITECTURE.md`, `SECURITY_POLICY.md`, `TESTING_POLICY.md`, `CODING_STANDARDS.md`, `DEFINITION_OF_DONE.md`, `docs/integrations/PASARGUARD.md`: align staging/production boundary, Owner login, ports, data source and delivery gates.
- `AGENTS.md`, `README.md`, `docs/AGENT_WORKFLOW.md`, `agents/README.md`, feature lifecycle, Implementation/Review/QA roles and directly relevant agent skills: lock spec approval, staged CI/CD safety and **Owner-only Ready/Merge** policy.
- PR template: distinguish planned docs/spec vs actually implemented/tested/released.

## Existing contracts reviewed and intentionally unchanged

- **`docs/DOMAIN_RULES.md`:** already correctly requires integer Toman, integer bytes and FP-002 GiB (`1024^3`) basis; fractional final-Toman rounding still requires FP-004 Owner approval. Billing Admin vs Actor, reset/renewal/Next Plan and unique charges are **not FP-003B scope**. No new accounting policy was invented merely to touch the file.
- **ADR 0001–0014:** reviewed against the staging proposal. In particular ADR 0001 modular monolith, 0002 PostgreSQL authority, 0003 Redis ephemeral, 0004 Pasarguard API/webhook-only, 0005 UTC/Jalali, 0006 integer Toman, 0007 effective dated pricing, 0008 idempotency, 0009 auditable events, 0010 inbox/outbox, 0011 TypeORM, 0012 raw retention, 0013 Owner-controlled financial shadow cutover and 0014 NestJS/Fastify remain accepted. New **ADR 0015** adds staging context without rewriting historical ADRs.
- FP-001, FP-002, FP-003A approved historical task/implementation files and FP-001 wire contract remain accurate original evidence boundaries. Their historical acceptance was already bannered; no need to rewrite contracts or expose private replay artifacts.
- `docker/compose.dev.yml`, `.env.example`, current application code, migrations, `.github/workflows/ci.yml` deliberately **unchanged by this docs-only PR**. Their production-like implementation belongs to the separately approved future FP-003B feature PR.

## Unresolved operator inputs, not permission to improvise

- Actual staging VPS provider, IP/IPv6, host OS, provider rescue access; Cloudflare A/AAAA/CAA; ACME contact email.
- Owner-managed SSH admin credential; dedicated deploy account **root-equivalent Docker access must be constrained or explicitly accepted**; GitHub Environment/registry permissions and access.
- Runtime secret provisioning and encrypted **off-host** PostgreSQL backup destination/retention. Production go-live, live webhook authentication and financial accounting remain separately gated.
- Detailed spec, ADR and first staging release require Owner acceptance and independent verification; no server/DNS/SSH modifications or code implementation are authorized by this docs PR.

**Official technical boundary references:** [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [Docker vs UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/), [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).
