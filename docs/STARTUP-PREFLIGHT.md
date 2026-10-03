# Agent Startup Preflight

Run this 8-step checklist at the start of every assigned session, before editing any file.

1. **Assignment check:** Confirm a human assigned the task through an issue. Read the dispatch brief (objective, risk tier, forbidden boundaries). Never assign yourself an issue.
2. **Rules:** Read [PRINCIPLES.md](PRINCIPLES.md) and the owning repo's root `AGENTS.md`. Flag any conflicting instructions.
3. **Runtime Binding:** Inspect and record the workspace:
   - Owning repository and remote origin.
   - Launcher session ID (if any) and isolated worktree path.
   - Branch name and base commit SHA (`git rev-parse HEAD`).
   - Confirm no other writer shares this worktree.
4. **Source of truth:** Find the specifications, contracts, source files and tests for the assigned surface. Check facts against source, not assumptions.
5. **Harness and tools:** Confirm the current harness has what the task needs (compiler, test runner, git, network).
6. **Boundary check:** Note the human-held singletons (production deploys, live CMS writes, code signing, licence issuance) and any local test environments you may use.
7. **Checkpoint:** If resuming, read `checkpoint.json`. If starting fresh, create it (schema version 1) with `goal`, empty `proven`, empty `blocked` and the immediate `next` action.
8. **Verification and review plan:** Decide the checks, the negative controls for critical guards, and whether HIGH/CRITICAL risk requires Apex Review. It does only when the author is below T0. Work authored by a T0 model is exempt (frontier does not review frontier); its gate is the two-axis review plus verified tests.

**If anything disagrees** (assignment, repository or worktree state versus the brief), stop, record the blocker in the checkpoint, and hand control back to the dispatcher.
