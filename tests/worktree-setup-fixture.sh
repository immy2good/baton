#!/usr/bin/env bash
# Run: npm run test:worktree   (needs git, node/npm, pwsh 7, jq)
# Real fixture: a scratch repo with every file the contract copies + an npm lockfile,
# then a linked worktree, then the ps1 and the hook. Asserts, not eyeballing.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$(cygpath -m "$(mktemp -d)")"  # forward slashes: the fixture pipes hand-built JSON to the hook
FX="$S/fx-main"; WT="$S/fx-wt"
rm -rf "$FX" "$WT"
mkdir -p "$FX/.claude" "$FX/config" && cd "$FX" || exit 1
git init -q -b main .
printf 'SECRET=1\n' > .env
printf '{"permissions":{}}\n' > .claude/settings.local.json
printf '{"port":1}\n' > config/app.local.json
printf '{"name":"fx","version":"1.0.0","private":true,"dependencies":{"is-odd":"3.0.1"}}\n' > package.json
npm install --no-audit --no-fund --silent >/dev/null 2>&1 || { echo "FAIL: npm install in fixture"; exit 1; }
rm -rf node_modules
printf '.env\n.env.local\n.claude/settings.local.json\nconfig/*.local.json\nnode_modules/\n.baton-worktree-setup.done\n' > .gitignore
# standard block straight from the doc
python - "$HERE" <<'PY'
import json,re,sys
doc=open(sys.argv[1]+"/docs/WORKTREE-ENVIRONMENT.md",encoding="utf-8").read()
m=re.search(r"```json\n(\{\n  \"worktree\".*?\n\})\n```",doc,re.S)
json.dump(json.loads(m.group(1)),open("baton.json","w",encoding="utf-8"),indent=2)
PY
[ -f baton.json ] || { echo "FAIL: fixture baton.json not built"; exit 1; }
git add -A >/dev/null && git -c user.email=t@t -c user.name=t commit -q -m fixture
git worktree add -q "$WT" -b wt-test

fail=0
ok(){ echo "ok   $1"; }; bad(){ echo "FAIL $1"; fail=1; }
chk(){ if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }

echo "== main checkout must be a no-op =="
out=$(pwsh -NoProfile -ExecutionPolicy Bypass -File $HERE/scripts/worktree-setup.ps1 -Path "$FX"); rc=$?
chk "main: exit 0" "$rc"
printf '%s' "$out" | grep -q "is the main checkout"; chk "main: says main checkout" "$?"
[ ! -f "$FX/.baton-worktree-setup.done" ]; chk "main: no marker written" "$?"

echo "== linked worktree: real copy + npm ci =="
out=$(pwsh -NoProfile -ExecutionPolicy Bypass -File $HERE/scripts/worktree-setup.ps1 -Path "$WT"); rc=$?
printf '%s\n' "$out" | grep -E '^\[baton setup\]|FAILED|done:'
chk "wt: exit 0" "$rc"
grep -q SECRET=1 "$WT/.env"; chk "wt: .env copied" "$?"
[ -f "$WT/.claude/settings.local.json" ]; chk "wt: settings.local.json copied" "$?"
[ -f "$WT/config/app.local.json" ]; chk "wt: config/*.local.json copied" "$?"
[ -d "$WT/node_modules/is-odd" ]; chk "wt: node_modules from npm ci" "$?"
[ -f "$WT/.baton-worktree-setup.done" ]; chk "wt: marker written" "$?"
st=$(cd "$WT" && git status --short); [ -z "$st" ]; chk "wt: git status clean (everything copied is ignored) [$st]" "$?"

echo "== evidence outlives stdout: the log in the worktree's private git dir =="
LOG="$(cd "$WT" && git rev-parse --path-format=absolute --git-dir)/baton-worktree-setup.log"
[ -f "$LOG" ]; chk "log: exists under the git dir ($LOG)" "$?"
case "$LOG" in "$FX"/.git/worktrees/*) r=0;; *) r=1;; esac; chk "log: lives in <main>/.git/worktrees/<name>/, never in the tree" "$r"
grep -q "npm ci" "$LOG" && grep -q "^\[worktree-setup\]   ok$" "$LOG"; chk "log: records each setup line and a per-line ok" "$?"
grep -q "done: .* line(s) ok" "$LOG"; chk "log: records the final verdict" "$?"
! grep -q "SECRET=1" "$LOG"; chk "log: never contains copied secret values" "$?"

echo "== logging can never break or mis-score the run =="
rm -f "$WT/.baton-worktree-setup.done"; rm -f "$LOG"; mkdir "$LOG"   # a directory where the log file should be = unwritable
out=$(pwsh -NoProfile -ExecutionPolicy Bypass -File "$HERE/scripts/worktree-setup.ps1" -Path "$WT" -Force); rc=$?
chk "unwritable log: run still exits 0" "$rc"
printf '%s' "$out" | grep -q "done: .* line(s) ok"; chk "unwritable log: verdict still printed, no line miscounted as FAILED" "$?"
! printf '%s' "$out" | grep -q "FAILED"; chk "unwritable log: zero FAILED lines" "$?"
[ -f "$WT/.baton-worktree-setup.done" ]; chk "unwritable log: marker still written" "$?"
rmdir "$LOG"

echo "== hook wrapper: skips set-up worktree, no-op on main, fails loud on bad line =="
out=$(printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$WT" | bash $HERE/scripts/hooks/worktree-setup-hook.sh); rc=$?
[ $rc -eq 0 ] && printf '%s' "$out" | grep -q "already set up"; chk "hook: exit 0 + already set up" "$?"
out=$(printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$FX" | bash $HERE/scripts/hooks/worktree-setup-hook.sh); rc=$?
[ $rc -eq 0 ] && [ -z "$out" ]; chk "hook: main checkout silent exit 0" "$?"
rm -f "$WT/.baton-worktree-setup.done"
python - "$WT" <<'PY'
import json,sys
p=sys.argv[1]+"/baton.json"; d=json.load(open(p)); d["worktree"]["setup"].insert(0,"cmd /c exit 7"); json.dump(d,open(p,"w"))
PY
out=$(printf '{"hook_event_name":"PostToolUse","tool_name":"EnterWorktree","cwd":"%s"}' "$WT" | bash $HERE/scripts/hooks/worktree-setup-hook.sh); rc=$?
[ $rc -eq 0 ] && printf '%s' "$out" | grep -q "FAILED: exit code 7" && printf '%s' "$out" | grep -q additionalContext && [ ! -f "$WT/.baton-worktree-setup.done" ]; r=$?; chk "hook: failing line -> exit 0, FAILED printed, additionalContext JSON emitted, no marker" "$r"; [ $r -eq 0 ] || { echo "--- rc=$rc out: ---"; printf "%s
" "$out" | grep -v "^\[worktree-setup\] ([0-9]"; echo "--- marker present: $([ -f "$WT/.baton-worktree-setup.done" ] && echo yes || echo no)"; }

echo "== cleanup =="
cd "$HERE" && git -C "$FX" worktree remove --force "$WT" && rm -rf "$S"
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
