# Contributing to baton

Thanks for helping. baton is small on purpose, so a few rules keep it that way.

## Ground rules

- **Zero runtime dependencies.** Node's standard library only. If you think a dependency is worth it, open an issue first.
- **Every change has a test, and you have seen it fail.** Revert your fix, run the test, watch it go red, restore the fix. Mention that you did this in the PR.
- **Deterministic beats clever.** Routing, gates and safety checks must give the same answer for the same input. Model calls (TypeSafe Jev) only *classify*; they never pick who does the work.
- **Fail toward safety.** When something is unknown (a launcher can't be read, a confidence is missing), keep the worktree, escalate to a human, or ask for more review. Never assume the happy path.

## Getting started

```bash
git clone https://github.com/immy2good/baton && cd baton
npm test               # unit tests (no network needed)
npm run test:worktree  # end-to-end worktree setup check
```

Requires Node 20+ and git. `FIXTURE_SHELL=pwsh npm run test:worktree` also checks the PowerShell setup block if you have PowerShell 7.

## Good first contributions

- **A new launcher** (`src/lib/launcher.mjs`): tmux sessions, a process list, another supervisor. See [docs/LAUNCHERS.md](docs/LAUNCHERS.md).
- **A new harness adapter** (`src/lib/adapters/`): Gemini CLI, Copilot, Aider.
- **Offline classifier keywords** (`src/lib/offline-classify.mjs`): add the words your tickets use, plus a test in `tests/offline-classify.test.mjs`.
- **Docs**: anything that confused you on day one.

## Pull requests

1. Branch from `main`.
2. Keep the PR to one change, and say what it fixes and how you proved it.
3. `npm test` must pass.

By contributing you agree your work is released under the [MIT licence](LICENSE).
