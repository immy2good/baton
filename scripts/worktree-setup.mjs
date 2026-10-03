#!/usr/bin/env node
/**
 * Bring a fresh git worktree up to a working environment from the repo's baton.json.
 *
 *   node scripts/worktree-setup.mjs [--path <worktree>] [--force]
 *
 * A new worktree has no dependencies and no local config. This runs the repo's
 * `worktree.setup` lines from inside any linked worktree, however it was created
 * (Claude Code --worktree, EnterWorktree, `git worktree add`, a launcher).
 *
 * One source of truth per repo: baton.json -> worktree.setup (or paseo.json, so a
 * repo that Paseo also sets up keeps a single block). Each line runs in its own
 * shell: `worktree.shell` = "sh" (default on macOS/Linux) or "pwsh" (default on
 * Windows). BATON_SOURCE_CHECKOUT_PATH and PASEO_SOURCE_CHECKOUT_PATH are both set
 * to the main checkout, so a block written for either works.
 *
 * Exit 0 when every line ran (or there was nothing to do), 1 when any line failed,
 * 2 when the path is not a git checkout. `.baton-worktree-setup.done` records the
 * last successful run, so hooks can call this on every session start cheaply; a
 * Paseo-written `.paseo-worktree-setup.done` counts too.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    path: { type: 'string', default: process.cwd() },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
});
if (values.help) {
  console.log('Usage: node scripts/worktree-setup.mjs [--path <worktree>] [--force]');
  process.exit(0);
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const where = resolve(values.path);
const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], where);
if (!gitDir) {
  console.log(`[worktree-setup] not a git checkout: ${where}`);
  process.exit(2);
}
const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], where);
const topLevel = git(['rev-parse', '--show-toplevel'], where);

// git prints both paths in its own form, so comparing them is separator-safe.
if (resolve(gitDir) === resolve(commonDir)) {
  console.log(`[worktree-setup] ${topLevel} is the main checkout; nothing to set up.`);
  process.exit(0);
}

const source = dirname(commonDir);
const marker = join(topLevel, '.baton-worktree-setup.done');
if (!values.force) {
  for (const m of [marker, join(topLevel, '.paseo-worktree-setup.done')]) {
    if (existsSync(m)) {
      console.log(`[worktree-setup] already set up (${readFileSync(m, 'utf8').split('\n')[0]}); use --force to rerun.`);
      process.exit(0);
    }
  }
}

const cfgFile = ['baton.json', 'paseo.json'].map(n => join(topLevel, n)).find(existsSync);
if (!cfgFile) {
  console.log(`[worktree-setup] no baton.json in ${topLevel} - this repo has no worktree environment contract yet.`);
  process.exit(0);
}
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
// A block may end by writing a marker itself (for launcher-native runs). Here the
// marker is written only when every line succeeded, so skip that line.
const lines = (cfg?.worktree?.setup || []).filter(l => !/\.(baton|paseo)-worktree-setup\.done/.test(l));
if (lines.length === 0) {
  console.log(`[worktree-setup] ${cfgFile} has no worktree.setup lines.`);
  process.exit(0);
}
const shell = cfg.worktree.shell || (process.platform === 'win32' ? 'pwsh' : 'sh');

// Evidence must outlive stdout. A long `npm ci` can outlast a harness's output
// window, so the agent never sees the final line and reruns --force, reinstalling
// everything. Every line therefore also goes to a log in this worktree's private
// git dir: never tracked, nothing to ignore. Logging must never break the run.
const logPath = join(gitDir, 'baton-worktree-setup.log');
function say(msg, reset = false) {
  console.log(msg);
  try {
    (reset ? writeFileSync : appendFileSync)(logPath, msg + '\n');
  } catch {
    // locked or unwritable log: stdout still carries every line
  }
}

function runLine(line) {
  const env = { ...process.env, BATON_SOURCE_CHECKOUT_PATH: source, PASEO_SOURCE_CHECKOUT_PATH: source };
  const opts = { cwd: topLevel, env, stdio: 'inherit', windowsHide: true };
  if (shell === 'pwsh') {
    const wrapped = `$ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0; ${line}; if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', wrapped], opts);
  }
  return spawnSync('sh', ['-c', `set -e\n${line}`], opts);
}

say(`# worktree-setup run ${new Date().toISOString()}`, true);
say(`[worktree-setup] worktree: ${topLevel}`);
say(`[worktree-setup] source:   ${source}`);
say(`[worktree-setup] shell:    ${shell}`);

let failed = 0;
lines.forEach((line, i) => {
  say(`[worktree-setup] (${i + 1}/${lines.length}) ${line}`);
  const r = runLine(line);
  if (r.error) {
    failed++;
    say(`[worktree-setup]   FAILED: ${r.error.code === 'ENOENT' ? `${shell} not found on PATH` : r.error.message}`);
  } else if (r.status !== 0) {
    failed++;
    say(`[worktree-setup]   FAILED: exit code ${r.status}`);
  } else {
    say('[worktree-setup]   ok');
  }
});

if (failed === 0) {
  writeFileSync(marker, `${new Date().toISOString()} from ${source}\n`);
  say(`[worktree-setup] done: ${lines.length} line(s) ok.`);
  say(`[worktree-setup] log: ${logPath}`);
  process.exit(0);
}
say(`[worktree-setup] ${failed} of ${lines.length} line(s) failed; marker not written.`);
say(`[worktree-setup] log: ${logPath}`);
process.exit(1);
