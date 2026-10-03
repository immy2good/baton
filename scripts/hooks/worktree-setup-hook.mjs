#!/usr/bin/env node
/**
 * Claude Code hook: bring a worktree up from the repo's baton.json.
 *
 * Wire it twice in ~/.claude/settings.json (see docs/WORKTREE-ENVIRONMENT.md):
 *   SessionStart              - `claude --worktree <name>` starts inside a fresh worktree
 *   PostToolUse EnterWorktree - Claude entered a worktree mid-session
 *
 * Reads the hook JSON on stdin and takes `cwd` (documented: the worktree root once
 * Claude is in it). The `tool_response` path fields are a best guess at the
 * EnterWorktree payload and are NOT documented - `cwd` is the contract; the guess
 * only wins when present. Runs scripts/worktree-setup.mjs there.
 *
 * Never blocks Claude: exit 0 on every path. SessionStart shows this output to
 * Claude; PostToolUse does not, so on failure we also emit hook JSON with
 * additionalContext so Claude sees it where the harness supports that.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'worktree-setup.mjs');

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  console.log('[worktree-setup-hook] unreadable hook input; skipping setup');
  process.exit(0);
}

const event = input.hook_event_name || '';
const cwd = input.tool_response?.path || input.tool_response?.worktreePath || input.cwd;
if (!cwd || !existsSync(cwd)) {
  console.log(`[worktree-setup-hook] no usable cwd in hook input (event=${event || '?'}); skipping`);
  process.exit(0);
}

// Only linked worktrees need setup.
const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
const top = git(['rev-parse', '--show-toplevel'], cwd);
if (!gitDir || !commonDir || !top || resolve(gitDir) === resolve(commonDir)) process.exit(0);

const r = spawnSync(process.execPath, [script, '--path', top], { encoding: 'utf8' });
const out = `${r.stdout || ''}${r.stderr || ''}`;
process.stdout.write(out);
if (r.status !== 0) {
  const msg = `worktree setup reported failures in ${top} (exit ${r.status}). Run: node ${script} --path "${top}" --force`;
  console.log(`[worktree-setup-hook] ${msg}`);
  if (event === 'PostToolUse') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
  }
}
process.exit(0);
