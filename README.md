# baton

**Hand a coding job from one AI agent to the next without dropping it.**

You run Claude Code, Codex, Cursor, OpenCode or Antigravity. One runs out of credits mid-task, or you want a second model to review the first one's work. baton is the small, zero-dependency Node toolkit that keeps the job moving:

- **Checkpoints.** Every agent writes `checkpoint.json` in its worktree each loop (goal, what is proven, what is blocked, the next step), so a successor resumes from the file, not from a dead chat.
- **Routing.** A roster of seats (writer, reviewer, apex reviewer, bulk, research) with tiers, model families and fallback chains. baton picks the writer and a reviewer **from a different model family**, walks sideways when a credit pool is dead, and never lets an unavailable model block the work.
- **Gates.** A receipt checker that refuses "done" without command evidence, a negative control and the right reviews, and flags agents that claim production deploys or other human-held actions.
- **Worktree safety.** One writer per git worktree; a setup script that gives a fresh worktree the main checkout's dependencies and local config; a prune guard that never deletes a worktree an agent is still using.
- **Swarm map.** A local web page showing agents, worktrees, checkpoints, PRs and an interactive dispatcher.

baton does not launch agents. You (or a launcher such as [Paseo](https://paseo.sh)) do; baton reads what is running through a small [launcher plug-in point](docs/LAUNCHERS.md).

## Quick start

Requires Node 20+ and git. The worktree setup script also needs PowerShell 7 (`pwsh`).

```bash
git clone https://github.com/<you>/baton && cd baton
npm test
```

Tell baton which agents are running (default `files` launcher):

```bash
node scripts/agents.mjs register --id claude-1 --provider claude
node scripts/agents.mjs list
node scripts/agents.mjs done --id claude-1
```

Classify an issue and get a writer/reviewer pairing (needs a [TypeSafe](https://typesafe.ai) API key in `TYPESAFE_API_KEY`; the routing itself is deterministic and local):

```bash
node scripts/dispatch-triage.mjs "Fix rounding in the refund calculation"
```

Check a completion receipt:

```bash
node scripts/receipt-gate.mjs path/to/receipt.json
```

Open the swarm map at http://127.0.0.1:8766:

```bash
npm run map
```

List the repos it should watch in `config/swarm-map.json` (copy [`config/examples/swarm-map.json`](config/examples/swarm-map.json); `config/*.json` is gitignored so your paths stay private).

## Make it yours

| File | What to edit |
|---|---|
| [`roster/profiles.json`](roster/profiles.json) | The agents you run: provider, model, mode, thinking level. Or set `BATON_PROFILES` to a private file. |
| [`roster/routing.json`](roster/routing.json) | Tiers, families, roles, fallback chains, domain specialists, the active-agent cap. |
| [`roster/pools.json`](roster/pools.json) | Credit pools that are out until a date; their seats are skipped until then. |
| [`src/lib/contract-lint.mjs`](src/lib/contract-lint.mjs) | The cross-repo contracts your repos share. |
| `baton.json` in each repo | The repo's worktree setup lines ([docs/WORKTREE-ENVIRONMENT.md](docs/WORKTREE-ENVIRONMENT.md)). |

## Docs

- [Principles](docs/PRINCIPLES.md): the rules baton enforces and why.
- [Launchers](docs/LAUNCHERS.md): `files` (default) or Paseo, and how to add another.
- [Startup preflight](docs/STARTUP-PREFLIGHT.md) and [completion gate](docs/COMPLETION-GATE.md): what an agent does first and last.
- [Risk classification](docs/RISK-CLASSIFICATION.md), [checkpoint schema](docs/CHECKPOINT-SCHEMA.md), [worktree environment](docs/WORKTREE-ENVIRONMENT.md).
- Templates: [repo `AGENTS.md`](docs/templates/REPO-AGENTS-TEMPLATE.md), [task packet](docs/templates/TASK-PACKET.md), [review-diamond recipe](docs/recipes/review-diamond.yml).

## Tests

```bash
npm test               # unit tests; live TypeSafe tests skip without a key
npm run test:worktree  # end-to-end worktree setup fixture (needs pwsh, jq)
```

## Licence

[MIT](LICENSE)
