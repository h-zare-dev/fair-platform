# Skill — Fair Platform Mutation Testing

Use mutation testing only for financially or correctness-critical pure domain logic where ordinary coverage can hide weak assertions.

## Policy
- Stryker is the planned mutation-testing tool.
- Do not introduce or run mutation testing for skeleton/infrastructure code unless the approved task explicitly requires it.
- Prioritize accounting, pricing, calendar boundaries, correlation, and other invariant-heavy logic.
- Surviving mutants in critical logic require stronger tests or an explicit documented rationale.
- Do not chase mutation score with meaningless assertions.

For FP-001, mutation testing is not required unless newly introduced pure fingerprint/canonicalization logic materially benefits from it and adding Stryker is separately approved.
