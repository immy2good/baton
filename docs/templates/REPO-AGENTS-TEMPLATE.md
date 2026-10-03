# Repository AGENTS.md Template

Copy this into the root `AGENTS.md` of a repo that agents work in.

```markdown
# <repository-name> — Agent Instructions

## Purpose and boundaries
- This repository owns <product code, tests and assets>.
- It does NOT own sibling repositories or agent dispatch.
- Coordination: issues in this repo.

## Source of truth and precedence
1. Direct human decisions.
2. This repo's decision records (`docs/adr/`) and specifications.
3. baton's principles (`docs/PRINCIPLES.md`).
4. Live source and tests.

## Worktree protocol
- Work only in an assigned git worktree; never directly on `main` or `develop`.
- Keep `checkpoint.json` (schema version 1) in the worktree root, updated every loop.
- Reviewers check out committed WIP branches in their own worktrees, using a different model family and harness.

## Build and verify
- Setup: `<setup command>`
- Fast check: `<lint/build command>`
- Full tests: `<test command>`
- Negative control: `<revert fix, see the test fail, restore fix>`

## Risk and review
- LOW/MEDIUM: fast review by a different family.
- HIGH/CRITICAL, author below T0: mandatory Apex Review, bound to the commit SHA. Work authored by a T0 model is exempt (frontier does not review frontier); its gate is the two-axis review plus verified tests.

## Human-held singletons
- Production deploys, live CMS writes, signing keys, licence issuance.
- Agent-allocatable: <sandboxes, emulators, demo accounts>.

## Completion
- Post a receipt to the issue with `verified`, `not_verified` and `capture` (a link to where durable knowledge was recorded, or `nothing durable`).
```
