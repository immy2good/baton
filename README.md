<div align="center">

# 🏃‍♂️ baton

### Hand a coding job from one AI agent to the next — without dropping it.

**Claude Code runs out of credits mid-task. Codex picks up exactly where it stopped. A different model reviews the work. Nothing is lost, nothing ships unproven.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Tests](https://img.shields.io/badge/tests-140%20passing-brightgreen)](tests)
[![Works with](https://img.shields.io/badge/works%20with-Claude%20Code%20·%20Codex%20·%20Cursor%20·%20OpenCode%20·%20Antigravity-8A2BE2)](#-works-with)

[Quick start](#-quick-start) · [How it works](#-how-it-works) · [Features](#-features) · [Docs](#-docs) · [FAQ](#-faq)

</div>

---

## The problem

You're running more than one AI coding agent. Then this happens:

- 🪫 **An agent hits its credit limit halfway through a ticket.** The context dies with the chat. The next agent starts from zero.
- 🪞 **The model that wrote the code also "reviews" it.** Same blind spots, same bugs, rubber-stamped.
- ✅ **"All tests pass!"** — with no output, no proof, and no test that ever failed without the fix.
- 💥 **Two agents edit the same folder.** Or a cleanup script deletes a worktree an agent was still using.
- 🚀 **An agent "helpfully" deploys to production.**

**baton is the relay protocol that fixes this.** It's a small, zero-dependency Node toolkit that sits beside the agents you already use — it doesn't replace them, wrap them, or need an account.

## ✨ Features

| | |
|---|---|
| 📍 **Checkpoints, not chat history** | Every agent writes `checkpoint.json` each loop — goal, what's proven, what's blocked, the exact next step. A successor resumes from the file, not a dead conversation. |
| 🔀 **Cross-model routing** | A roster of seats (writer, reviewer, apex reviewer, bulk, research) with tiers and model families. baton picks the writer and a reviewer **from a different model family**. Deterministic — no LLM picks who does the work. |
| 🪫 **Credit-death fallbacks** | Mark a credit pool as out until a date. Its seats are skipped; baton walks the fallback chain **sideways or down a tier, never up**, and an unavailable model never blocks the work. |
| 🧾 **Completion gate** | `done` requires a receipt: real command output, a negative control, the right reviews bound to a commit SHA. Claims of production deploys get flagged as a singleton breach. |
| 🌳 **Worktree safety** | One writer per git worktree. One script gives every fresh worktree the main checkout's dependencies and local config. The prune guard **never** deletes a worktree with an agent in it. |
| 🗺️ **Swarm map** | A local web page: running agents, worktrees, checkpoints, open PRs, and an interactive dispatcher. |
| 🔌 **Bring your own launcher** | Agents register with a one-line CLI, or baton reads [Paseo](https://paseo.sh) automatically. Add your own in ~30 lines. |

## 🧭 How it works

```mermaid
flowchart LR
    I[📋 Issue] --> T{baton triage}
    T -->|routes by domain, risk, credit pools| W[✍️ Writer<br/>e.g. Claude]
    W -->|checkpoint.json<br/>every loop| C[(Worktree)]
    W -. credits run out .-> S[✍️ Successor<br/>e.g. Codex]
    C --> S
    S -->|WIP branch| R[🔍 Reviewer<br/>different family]
    R -->|risk ≥ high| A[🛡️ Apex reviewer]
    R --> G{Receipt gate}
    A --> G
    G -->|proven| D[✅ Done]
    G -->|no evidence| W
```

1. **Triage** classifies the issue (domain, risk, whether it needs an apex review) and the **roster** deterministically names the writer and reviewers.
2. The **writer** works in its own worktree and writes `checkpoint.json` every loop.
3. If it dies, a **successor** — any harness — reads the checkpoint and carries on.
4. A **reviewer from a different model family** checks the committed branch. High-risk work also gets an **apex review** (unless a frontier model wrote it: *frontier doesn't review frontier*).
5. The **receipt gate** decides whether it's actually done.

## 🚀 Quick start

Requires **Node 20+** and git. (The worktree setup script also needs PowerShell 7.)

```bash
git clone https://github.com/immy2good/baton && cd baton
npm test
```

**Tell baton what's running:**

```bash
node scripts/agents.mjs register --id claude-1 --provider claude
node scripts/agents.mjs list
#   launcher files: 1 agent(s)
#     claude-1   running  claude   /code/web-app
node scripts/agents.mjs done --id claude-1
```

**Route an issue** (classification uses a [TypeSafe](https://typesafe.ai) key in `TYPESAFE_API_KEY`; the routing itself is local and deterministic):

```bash
node scripts/dispatch-triage.mjs "Fix rounding in the refund calculation"
```

**Gate a completion receipt** (the bundled example is deliberately weak, and gets rejected):

```bash
node scripts/receipt-gate.mjs docs/schemas/examples/receipt.valid.json
#   Gate Verdict:    REJECT_INSUFFICIENT_PROOF
#   Findings:        Evidence missing executable proof: verified items must cite
#                    commands, exit status, or test runner output
```

**Open the swarm map** at http://127.0.0.1:8766:

```bash
npm run map
```

## 📍 A checkpoint looks like this

```json
{
  "schema_version": 1,
  "ticket": "https://github.com/acme/web-app/issues/123",
  "node": "claude",
  "repo": "web-app",
  "branch": "agent/claude/fix-session-timeout",
  "goal": "Fix session timeout regression after login",
  "updated_at": "2026-09-19T22:00:00Z",
  "proven": ["npm test: 212 passed; new timeout test fails without the fix"],
  "blocked": [],
  "next": "Ask the reviewer seat to check out the WIP branch"
}
```

Any agent that can read a file can resume from it. That's the whole trick.

## 🤝 Works with

Claude Code · OpenAI Codex · Cursor (ACP) · OpenCode · Antigravity · Perplexity (research seat) — anything you can describe as a provider + model in [`roster/profiles.json`](roster/profiles.json).

## 🛠️ Make it yours

| File | What it controls |
|---|---|
| [`roster/profiles.json`](roster/profiles.json) | The agents you run: provider, model, mode, thinking level. Or point `BATON_PROFILES` at a private file. |
| [`roster/routing.json`](roster/routing.json) | Tiers, families, roles, fallback chains, domain specialists, the active-agent cap. |
| [`roster/pools.json`](roster/pools.json) | Credit pools that are out until a date. |
| [`src/lib/contract-lint.mjs`](src/lib/contract-lint.mjs) | Cross-repo contracts your repos share. |
| `baton.json` (per repo) | Worktree setup lines — [details](docs/WORKTREE-ENVIRONMENT.md). |
| `config/swarm-map.json` | Repos the map watches (gitignored; copy [the example](config/examples/swarm-map.json)). |

## 📚 Docs

- **[Principles](docs/PRINCIPLES.md)** — the rules baton enforces, and why
- **[Launchers](docs/LAUNCHERS.md)** — `files` (default), Paseo, or your own
- **[Startup preflight](docs/STARTUP-PREFLIGHT.md)** and **[completion gate](docs/COMPLETION-GATE.md)** — what an agent does first and last
- **[Risk classification](docs/RISK-CLASSIFICATION.md)** · **[Checkpoint schema](docs/CHECKPOINT-SCHEMA.md)** · **[Worktree environment](docs/WORKTREE-ENVIRONMENT.md)**
- Templates: **[repo `AGENTS.md`](docs/templates/REPO-AGENTS-TEMPLATE.md)** · **[task packet](docs/templates/TASK-PACKET.md)** · **[review-diamond recipe](docs/recipes/review-diamond.yml)**

## ❓ FAQ

**Is this another agent framework?**
No. baton never runs a model. It's the protocol and guardrails *between* the agents you already use.

**Do I need Paseo?**
No. The default launcher is a folder of JSON files. Paseo is detected automatically if you have it.

**Do I need the TypeSafe key?**
Only for automatic issue classification. Routing, fallbacks, the receipt gate, checkpoints and worktree tools all work offline.

**Why "a reviewer from a different family"?**
A model reviewing its own family's code shares its blind spots. baton enforces writer ≠ reviewer *family*, not just writer ≠ reviewer.

**What's a "negative control"?**
Proof the test catches the bug: revert the fix, watch the test fail, restore it, watch it pass. A green suite proves nothing until you've seen it go red.

## 🧪 Tests

```bash
npm test               # 140 unit tests; live TypeSafe tests skip without a key
npm run test:worktree  # end-to-end worktree setup fixture (needs pwsh, jq)
```

## 🤲 Contributing

Issues and PRs welcome — especially new [launchers](docs/LAUNCHERS.md) and harness adapters (`src/lib/adapters/`). Keep it zero-dependency, add a test, and show it failing before your fix.

## 📄 Licence

[MIT](LICENSE) — if baton saves one of your agents from a credit-death, a ⭐ helps others find it.
