#!/usr/bin/env bash
# Claude Code hook wrapper: bring a worktree up from the repo's baton.json.
#
# Wire it twice in ~/.claude/settings.json (see docs/WORKTREE-ENVIRONMENT.md):
#   SessionStart              - `claude --worktree <name>` starts inside a fresh worktree
#   PostToolUse EnterWorktree - Claude entered a worktree mid-session
#
# Reads the hook JSON on stdin and takes `cwd` (documented: the worktree root once
# Claude is in it). The `tool_response` path fields are a best guess at the
# EnterWorktree payload and are NOT documented - `cwd` is the contract; the guess
# only wins when present. Runs scripts/worktree-setup.ps1 there.
#
# Never blocks Claude: exit 0 on every path. SessionStart shows this output to
# Claude; PostToolUse does not, so on failure we also emit hook JSON with
# additionalContext so Claude sees it where the harness supports that.
set -u

if ! command -v jq >/dev/null 2>&1; then
  echo "[worktree-setup-hook] jq not on PATH; cannot read hook input - skipping setup"
  exit 0
fi

input="$(cat)"
event="$(printf '%s' "$input" | jq -r '.hook_event_name // empty')"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
resp_path="$(printf '%s' "$input" | jq -r '.tool_response.path // .tool_response.worktreePath // empty')"
[ -n "$resp_path" ] && cwd="$resp_path"
if [ -z "$cwd" ] || [ ! -d "$cwd" ]; then
  echo "[worktree-setup-hook] no usable cwd in hook input (event=${event:-?}); skipping"
  exit 0
fi

# Only linked worktrees need setup. git prints both paths in its own form, so
# comparing them is separator-safe (the ps1 does the same).
gitdir="$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
common="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$gitdir" ] && [ -n "$common" ] && [ -n "$top" ] || exit 0
[ "$gitdir" != "$common" ] || exit 0

script="${BATON_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/scripts/worktree-setup.ps1"
if [ ! -f "$script" ]; then
  echo "[worktree-setup-hook] missing $script (set BATON_DIR to the baton checkout)"
  exit 0
fi

out="$(pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$script" -Path "$top" 2>&1)"
rc=$?
printf '%s\n' "$out"
if [ "$rc" -ne 0 ]; then
  msg="worktree setup reported failures in $top (exit $rc). Run: pwsh -File $script -Force"
  echo "[worktree-setup-hook] $msg"
  if [ "$event" = "PostToolUse" ]; then
    jq -cn --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
  fi
fi
exit 0
