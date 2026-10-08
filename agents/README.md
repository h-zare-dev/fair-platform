# Fair Platform Agents

This directory defines the execution roles and workflow controls used for agent-assisted development in Fair Platform.

For feature work, read in this order:

1. `AGENTS.md`
2. `agents/feature-lifecycle.md`
3. the role file for the current agent (`implementation.md`, `review.md`, or `qa.md`)
4. the approved task specification under `docs/tasks/`
5. the task-referenced architecture, domain, security, testing, and ADR documents

All feature implementation/review/QA cycles stay on the same feature branch and Draft PR until merge gates pass. Agents must never merge a feature PR without explicit human instruction.
