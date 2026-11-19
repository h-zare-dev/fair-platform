# Fair Platform Agents

This directory defines the execution roles and workflow controls used for agent-assisted development in Fair Platform.

For feature work, read in this order:

1. `AGENTS.md`
   - `docs/ROADMAP.md` — current milestone and approval status.
   - For **current** stages, read `docs/CURRENT_STATE_AND_POLICY_2026-11-19.md` and the current `docs/ROADMAP.md`. FP-003B is implemented/Owner-reported active; its **Staging-only** SSH/backup exceptions are ADR 0016/0017. FP-004 synthetic pricing exists, while its new admin-group/nightly design remains unimplemented and implementation-spec-gated.
2. `agents/feature-lifecycle.md`
3. the role file for the current agent (`implementation.md`, `review.md`, or `qa.md`)
4. the approved task specification under `docs/tasks/`
5. the task-referenced architecture, domain, security, testing, and ADR documents

All feature implementation/review/QA cycles stay on the same feature branch and Draft PR until merge gates pass. **Only the human Owner** marks PRs Ready and executes merges; agents/assistants never do either.
