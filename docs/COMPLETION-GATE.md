# Completion and Handoff Gate

An agent may report **done** only when the objective is proven with command evidence and every applicable review gate has passed. `npm run gate` checks a receipt against these rules.

## Pre-completion checklist

1. **Scope:** The diff matches the assigned issue and nothing else. Out-of-scope findings go to separate issues.
2. **Command evidence:** Run the required builds, linters and tests. Paste the exact output into the receipt. Never assert "tests pass" without it.
3. **Negative control:** If the change fixes a bug or adds a guard, prove that reverting it makes the test fail and restoring it makes the test pass.
4. **Independent review:**
   - **LOW / MEDIUM** risk: review by a different model family and harness.
   - **HIGH / CRITICAL** risk: **Mandatory Apex Review** by a T0 reviewer when the author is below T0. Work *authored* by a T0 model is not sent to another T0 model; its gate is the two-axis review, fixes and verified test output, anchored to the commit SHA. Every approval must name the exact reviewed commit SHA.
5. **Clean worktree:** `git status` is clean: no stray artifacts, temporary logs or credentials.
6. **Checkpoint:** Update `checkpoint.json` with the final `proven` list, an empty `blocked` list and a clear `next` step.
7. **Capture:** Record any durable decision or lesson where your team keeps knowledge (repo docs, wiki), and link it in `capture`, or write exactly `nothing durable`.

## Receipt structure

Post a receipt to the issue that matches [`schemas/receipt.schema.json`](schemas/receipt.schema.json):
- `schema_version`: `1`
- `ticket`: issue reference
- `node`: harness (`claude`, `codex`, `cursor`, `opencode`, ...)
- `outcome`: `done` | `blocked` | `handed_off` | `failed_start`
- `commit`, `branch`
- `verified`: checks run, with exact command summaries
- `not_verified`: surfaces not verified in this session, and why
- `capture`: link, or `nothing durable`

## Stop rules
- Stop on **done** once the receipt and capture are posted.
- Stop on **blocked** at a missing dependency, a failed preflight, or a human-held singleton (deploy, live CMS write, signing). Do not guess or bypass.
