# Principles

The rules baton enforces, and why. Code and tests implement them; this page is the summary.

## 1. A human dispatches, agents work
- **One dispatcher.** A human (optionally with a launcher such as Paseo) assigns work. An agent is a worker, not a dispatcher: it never assigns itself a ticket.
- **Coordination happens in the ticket.** Work between repos is coordinated through an issue in the repo that owns the change. baton is not a message queue or a claim bus.
- **Precedence.** Direct human instructions > the repo's own `AGENTS.md` / `CLAUDE.md` > these principles. If they conflict, surface the contradiction with evidence before continuing.

## 2. One writer per worktree
- Each coding agent works in its own git worktree on its own branch. Two writers never share a working tree.
- Reviewers check out the writer's committed work-in-progress branch in a separate worktree, using a **different model family and harness** from the writer.
- State is written down every loop in `checkpoint.json` at the worktree root (see [CHECKPOINT-SCHEMA.md](CHECKPOINT-SCHEMA.md)), so a successor can pick the job up when an agent runs out of credits or stops.

## 3. Seats, not vendors
The roster (`roster/profiles.json` + `roster/routing.json`) describes seats by tier and role:

| Seat | Job |
|---|---|
| Orchestrator | Breaks work into steps inside its own session. Does not dispatch tickets. |
| Apex reviewer (T0) | Security audits, high and critical risk, novel architecture. Never a writer. |
| Writers (T1-T3) | Implement in isolated worktrees. |
| Fast reviewers | Independent second opinion from a different family. |
| Researchers | Cited briefs only; write no product code. |
| Bulk (T4) | High-volume mechanical tasks. |

**Frontier does not review frontier.** Work written by a T0 model is not sent to another T0 model; its gate is the two-axis review plus verified test output.

**Unavailable models never block work.** When a seat's credit pool is dead (`roster/pools.json`), baton walks its fallback chain sideways or down a tier, never up, and finally the failsafe list.

## 4. Source of truth
- Product intent belongs to the people who own the product; implementation belongs to each repo.
- Old handoffs, model output and chat transcripts are leads, not authority. Inspect live source and current tests before changing a contract.
- Reversing a decision means writing down the new decision at the same time.

## 5. Evidence over assertion
- A claim without command output is a hypothesis. Never say "tests pass" without the output.
- A green suite proves nothing until you have seen the guard fail without the fix (a negative control).
- Review sign-offs are bound to the exact commit SHA reviewed. A later commit invalidates them.

## 6. Human-held singletons
Production deploys, live CMS writes, signing keys, licence issuance and real-money accounts are held by a human. Agents prepare and verify up to that boundary and stop.

Local test environments (sandboxes, emulators, demo accounts) are **NOT human-held singletons**: agents may create and use their own.

## 7. Done means proven
A task is done only when evidence is verified, the negative control is satisfied, the required reviews are approved, and a receipt is posted to the ticket (see [COMPLETION-GATE.md](COMPLETION-GATE.md)). The receipt's `capture` line links to where durable knowledge was recorded, or says exactly `nothing durable`.
