## Summary

Describe the approved change and why it is needed.

## Verification

- [ ] Scope matches the approved task specification.
- [ ] Business/accounting semantics were not invented or changed.
- [ ] Tests were added/updated where applicable.
- [ ] Typecheck/lint/format/build pass locally where applicable.
- [ ] Migration added and tested if persistence schema changed.
- [ ] No secrets or sensitive production payload data were added.
- [ ] Documentation/ADR updated if an approved decision changed.

## Roadmap and release gates

- [ ] Feature number/order follows `docs/ROADMAP.md`; implementation spec is **explicitly Owner-approved**, not only a design brief.
- [ ] No changes silently enable live Pasarguard webhooks, Production financial posting, or deployment to `main`.
- [ ] If changing FP-003B, separate PR quality from staging deployment secrets; Owner-only login and no public registration; Caddy-only TCP/443 Docker publish, SSH-key TCP/22, persistent synthetic database, backup/rollback/health tests addressed.
- [ ] Independent Review and QA and required CI evaluated for this head SHA; **only the human Owner** may mark Ready or execute Merge.
