# Worktree Environment

**Every worktree should start with everything the main checkout has**: dependencies, local config and the instructions agents need, whichever tool created it. An agent that begins by discovering `node_modules` is missing has already lost time on the ticket.

## One source of truth per repo: `baton.json → worktree.setup`

Each repo lists its setup lines once. `scripts/worktree-setup.ps1` runs them from inside any linked worktree:

| Worktree created by | What runs the setup |
|---|---|
| Claude Code `claude --worktree <name>` | `SessionStart` hook → `scripts/hooks/worktree-setup-hook.sh` |
| Claude Code `EnterWorktree` | `PostToolUse` hook (matcher `EnterWorktree`) → same |
| Claude subagent `isolation: worktree` | **Files only**, via `.worktreeinclude`. No hook fires for these, so dependencies are not installed. |
| `git worktree add` by hand, or any other tool | `pwsh -File <baton>/scripts/worktree-setup.ps1` from inside the worktree |
| Paseo | Paseo runs `paseo.json → worktree.setup` itself. The script also reads `paseo.json` when there is no `baton.json`, so one block serves both. |

The script is idempotent: it writes `.baton-worktree-setup.done` only when every line succeeded and skips on the next start; `-Force` reruns. It is a no-op in the main checkout (it compares git's own `--git-dir` and `--git-common-dir`, so path separators cannot fool it). It needs `pwsh` 7+.

**Evidence outlives stdout.** Every line is also written to `<git-dir>/baton-worktree-setup.log` (inside the main repo's `.git/worktrees/<name>/`: never tracked, nothing to ignore). A long install can outlast a harness's output window, so the agent never sees `done:`. **Do not rerun `-Force` just to see it**: `npm ci` wipes and reinstalls. Read the log, or run without `-Force` (instant `already set up`) and cite the marker.

## The standard block

Copy into the repo's `baton.json`, keep the lines that apply, delete the rest. Every line is PowerShell, idempotent and safe to rerun. `$env:BATON_SOURCE_CHECKOUT_PATH` is the main checkout (the script also sets `$env:PASEO_SOURCE_CHECKOUT_PATH` to the same path).

```json
{
  "worktree": {
    "setup": [
      "foreach ($f in '.env','.env.local') { if (Test-Path \"$env:BATON_SOURCE_CHECKOUT_PATH\\$f\") { Copy-Item -Force \"$env:BATON_SOURCE_CHECKOUT_PATH\\$f\" $f } }",
      "New-Item -ItemType Directory -Force .claude | Out-Null; if (Test-Path \"$env:BATON_SOURCE_CHECKOUT_PATH\\.claude\\settings.local.json\") { Copy-Item -Force \"$env:BATON_SOURCE_CHECKOUT_PATH\\.claude\\settings.local.json\" .claude\\settings.local.json }",
      "if (Test-Path \"$env:BATON_SOURCE_CHECKOUT_PATH\\config\") { New-Item -ItemType Directory -Force config | Out-Null; Get-ChildItem \"$env:BATON_SOURCE_CHECKOUT_PATH\\config\\*.local.json\" -ErrorAction SilentlyContinue | Copy-Item -Destination config\\ -Force }",
      "if (Test-Path package-lock.json) { npm ci --no-audit --no-fund } elseif (Test-Path pnpm-lock.yaml) { pnpm install --frozen-lockfile } elseif (Test-Path package.json) { npm install --no-audit --no-fund }",
      "if (Test-Path composer.json) { composer install --no-interaction --prefer-dist }",
      "if ((Test-Path pyproject.toml) -or (Test-Path requirements.txt)) { if (-not (Test-Path .venv)) { uv venv .venv | Out-Null }; if (Test-Path uv.lock) { uv sync } elseif (Test-Path requirements.txt) { uv pip install --python .venv -r requirements.txt } else { uv pip install --python .venv -e . } }",
      "Write-Host \"[baton setup] env: $(Test-Path .env) local-settings: $(Test-Path .claude\\settings.local.json) node_modules: $(Test-Path node_modules) vendor: $(Test-Path vendor) .venv: $(Test-Path .venv)\""
    ]
  }
}
```

Rules:

- **Dependencies come from the lockfile.** `npm ci`, `pnpm --frozen-lockfile`, `composer install`, `uv sync`. Never `npm install` when a lockfile exists. The `uv` line assumes a `[project]` table; commit `uv.lock` to pin.
- **A repo with no runtime dependencies drops that line.** `npm install` on a dependency-free `package.json` litters a lockfile and `node_modules` in every worktree.
- **Local config is copied, never generated.** `.env`, `.claude/settings.local.json` (saved permission approvals; without it every worktree re-prompts) and `config/*.local.json` come from the main checkout. **Each must be in the repo's `.gitignore`**: `.worktreeinclude` only copies files the repo itself ignores.
- **Nothing consequential in setup.** No compile, sign, package, deploy or launch.
- **Secrets stay in the main checkout's gitignored files.** Setup copies them; it never writes them from a string.

## `.worktreeinclude`

Claude Code copies gitignored files that match `.worktreeinclude` into every worktree it creates with git (`--worktree`, subagents, parallel sessions). It runs before any hook, so add it next to the `baton.json` block:

```text
.env
.env.local
.claude/settings.local.json
config/*.local.json
```

It only copies files; dependencies still need the hook.

Proof: `npm run test:worktree` builds a scratch repo with every file the contract copies plus a real npm lockfile, creates a linked worktree, and checks the copies, `npm ci`, the marker, the main-checkout no-op and the hook's failure path.

## Agent instructions in a worktree

Claude Code loads the repo's `CLAUDE.md` in a worktree as in the main checkout. Other harnesses (Codex, OpenCode, Cursor, Antigravity) only know what `AGENTS.md` tells them, so put this in every repo's `AGENTS.md`:

```markdown
## Fresh worktree

Missing `node_modules` / `vendor` / `.venv` / `.env`? Run
`pwsh -File <path-to-baton>/scripts/worktree-setup.ps1` from the worktree root.
It runs this repo's `baton.json → worktree.setup`.
```

## Claude Code hook wiring (once per machine, `~/.claude/settings.json`)

```json
"SessionStart": [
  { "hooks": [ { "type": "command", "command": "bash <path-to-baton>/scripts/hooks/worktree-setup-hook.sh", "timeout": 300 } ] }
],
"PostToolUse": [
  { "matcher": "EnterWorktree", "hooks": [ { "type": "command", "command": "bash <path-to-baton>/scripts/hooks/worktree-setup-hook.sh", "timeout": 300 } ] }
]
```

Merge into your existing arrays; do not replace them. The hook exits 0 on every path: it can print failures but never blocks a session. `SessionStart` output reaches Claude; `PostToolUse` output does not, so on failure the hook also emits `additionalContext` JSON for that event.

**Accepted risk:** setup lines run verbatim. A reviewer who checks out a writer's branch runs that branch's `baton.json` on session start. Mitigation: changes to `baton.json` are part of the diff every review reads, and nothing consequential belongs in setup.
