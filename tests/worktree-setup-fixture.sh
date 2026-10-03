#!/usr/bin/env bash
# Run: npm run test:worktree   (needs git, node/npm; pwsh too when testing the PowerShell block)
# Real fixture: a scratch repo with every file the contract copies + an npm lockfile,
# then a linked worktree, then the setup script and the hook. Asserts, not eyeballing.
#
# FIXTURE_SHELL=sh (default) tests the POSIX block from docs/WORKTREE-ENVIRONMENT.md;
# FIXTURE_SHELL=pwsh tests the PowerShell block.
set -u
SHELL_UNDER_TEST="${FIXTURE_SHELL:-sh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
# forward slashes on Windows: the fixture pipes hand-built JSON to the hook
if command -v cygpath >/dev/null 2>&1; then S="$(cygpath -m "$TMP")"; else S="$TMP"; fi
FX="$S/fx-main"; WT="$S/fx-wt"
SETUP="$HERE/scripts/worktree-setup.mjs"; HOOK="$HERE/scripts/hooks/worktree-setup-hook.mjs"
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
# the standard block for this shell, straight from the doc
node -e '
const fs = require("fs");
const doc = fs.readFileSync(process.argv[1] + "/docs/WORKTREE-ENVIRONMENT.md", "utf8");
const blocks = [...doc.matchAll(/```json\n(\{\n  "worktree"[\s\S]*?\n\})\n```/g)].map(m => JSON.parse(m[1]));
const want = process.argv[2];
const block = blocks.find(b => (b.worktree.shell || "sh") === want);
if (!block) { console.error("no " + want + " block in the doc"); process.exit(1); }
fs.writeFileSync("baton.json", JSON.stringify(block, null, 2));
' "$HERE" "$SHELL_UNDER_TEST" || { echo "FAIL: fixture baton.json not built"; exit 1; }
git add -A >/dev/null && git -c user.email=t@t -c user.name=t commit -q -m fixture
git worktree add -q "$WT" -b wt-test

fail=0
ok(){ echo "ok   $1"; }; bad(){ echo "FAIL $1"; fail=1; }
chk(){ if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }
echo "== shell under test: $SHELL_UNDER_TEST =="

echo "== main checkout must be a no-op =="
out=$(node "$SETUP" --path "$FX"); rc=$?
chk "main: exit 0" "$rc"
printf '%s' "$out" | grep -q "is the main checkout"; chk "main: says main checkout" "$?"
[ ! -f "$FX/.baton-worktree-setup.done" ]; chk "main: no marker written" "$?"

echo "== linked worktree: real copy + npm ci =="
out=$(node "$SETUP" --path "$WT" 2>&1); rc=$?
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
out=$(node "$SETUP" --path "$WT" --force 2>&1); rc=$?
chk "unwritable log: run still exits 0" "$rc"
printf '%s' "$out" | grep -q "done: .* line(s) ok"; chk "unwritable log: verdict still printed, no line miscounted as FAILED" "$?"
! printf '%s' "$out" | grep -q "FAILED"; chk "unwritable log: zero FAILED lines" "$?"
[ -f "$WT/.baton-worktree-setup.done" ]; chk "unwritable log: marker still written" "$?"
rmdir "$LOG"

echo "== hook: skips set-up worktree, no-op on main, fails loud on bad line =="
out=$(printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$WT" | node "$HOOK"); rc=$?
[ $rc -eq 0 ] && printf '%s' "$out" | grep -q "already set up"; chk "hook: exit 0 + already set up" "$?"
out=$(printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$FX" | node "$HOOK"); rc=$?
[ $rc -eq 0 ] && [ -z "$out" ]; chk "hook: main checkout silent exit 0" "$?"
rm -f "$WT/.baton-worktree-setup.done"
node -e 'const fs=require("fs");const p=process.argv[1]+"/baton.json";const d=JSON.parse(fs.readFileSync(p,"utf8"));d.worktree.setup.unshift("exit 7");fs.writeFileSync(p,JSON.stringify(d))' "$WT"
out=$(printf '{"hook_event_name":"PostToolUse","tool_name":"EnterWorktree","cwd":"%s"}' "$WT" | node "$HOOK"); rc=$?
[ $rc -eq 0 ] && printf '%s' "$out" | grep -q "FAILED: exit code 7" && printf '%s' "$out" | grep -q additionalContext && [ ! -f "$WT/.baton-worktree-setup.done" ]; r=$?
chk "hook: failing line -> exit 0, FAILED printed, additionalContext JSON emitted, no marker" "$r"
[ $r -eq 0 ] || { echo "--- rc=$rc out: ---"; printf '%s\n' "$out" | grep -v "^\[worktree-setup\] ([0-9]"; }

echo "== cleanup =="
cd "$HERE" && git -C "$FX" worktree remove --force "$WT" && rm -rf "$TMP"
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
