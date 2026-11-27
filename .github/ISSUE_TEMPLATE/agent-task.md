---
name: Agent implementation task
about: Owner-approved specification required before autonomous execution; never a blanket agent authorization
title: "[Agent Task] "
---

## Planning and authority

Owner-approved implementation-grade spec: `docs/tasks/<TASK-ID>-<slug>.md`

Pinned spec commit SHA: `<sha>`

Owner approval evidence: `<owner-authenticated approval reference>`

Base: `development`

> An Issue alone does not authorize execution. ChatGPT and Owner set the scope; the laptop Orchestrator checks exact spec SHA and Owner approval before queueing.

## Scope and acceptance criteria

- [ ] Describe deliverables and invariants with explicit measurable acceptance tests.
- [ ] Identify migrations/rollback and synthetic Lab E2E scenarios.
- [ ] Declare areas explicitly out of scope.
- [ ] Identify undecided accounting/financial rules; block if unresolved.

## Agent evidence

- [ ] Implementation: committed SHA / unit and integration results
- [ ] Independent Review: same SHA / findings and verdict
- [ ] Independent QA: same SHA / regression and adversarial results
- [ ] Merge candidate: latest development SHA / CI
- [ ] Isolated Lab: tested SHA/digest / real PasarGuard and E2E results
- [ ] Rework loops: defect→fix→all rechecks recorded
- [ ] Owner final review: only Owner may mark PR Ready and merge
- [ ] Post-merge: actual development SHA and checks pass

## Restrictions

No production SSH, real customer data, live billing, unknown financial interpretation, raw secrets in GitHub, direct protected-branch pushes or agent merge.
