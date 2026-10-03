/**
 * Where baton learns which agents are running, and in which folder.
 *
 * baton does not launch agents. Something else does: you in a terminal, an IDE,
 * or a supervisor such as Paseo. This module is the one seam between baton and
 * that launcher, so the rest of baton never knows which one is in use.
 *
 * Launchers:
 *   - `files` (default): each agent registers itself by writing a small JSON file
 *     to `$BATON_HOME/agents/` (default `~/.baton/agents/`). Use
 *     `node scripts/agents.mjs register|done` by hand or from a harness hook.
 *   - `paseo`: reads `paseo ls --json`. Chosen automatically when `~/.paseo`
 *     exists; force either one with `BATON_LAUNCHER=files|paseo`.
 *
 * Every launcher returns the same shape:
 *   { ok: true, value: Agent[] } | { ok: false, reason: string }
 * `ok: false` means "cannot see the agents", which is NOT the same as "no agents
 * are running". Callers that delete things (worktree prune) must treat it as
 * unknown and keep everything.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Statuses that mean an agent is holding capacity. `idle` agents are not. */
export const ACTIVE_STATUSES = ['running', 'working', 'busy'];

/** A file-registered agent that has not checked in for this long is reported as `stale`. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export function batonHome(env = process.env) {
  return env.BATON_HOME || join(homedir(), '.baton');
}

export function agentsDir(env = process.env) {
  return join(batonHome(env), 'agents');
}

/** Which launcher to use: explicit `BATON_LAUNCHER`, else Paseo when it is installed, else files. */
export function resolveLauncherName({ env = process.env, exists = existsSync } = {}) {
  const forced = String(env.BATON_LAUNCHER || '').toLowerCase();
  if (forced === 'files' || forced === 'paseo') return forced;
  return exists(join(homedir(), '.paseo')) ? 'paseo' : 'files';
}

function normaliseAgent(a) {
  const fullId = String(a.id ?? a.agentId ?? '');
  return {
    id: fullId.slice(0, 7),
    fullId,
    name: a.name ?? a.title ?? '(untitled)',
    provider: a.provider ?? '',
    thinking: a.thinking ?? 'standard',
    status: a.status ?? a.lastStatus ?? 'unknown',
    cwd: String(a.cwd ?? '').replace(/\\/g, '/'),
    created: a.created ?? ''
  };
}

/** Agents from `paseo ls --json`. */
export function paseoLauncher({ exec = execFileSync } = {}) {
  try {
    // Windows: `paseo` is a .cmd shim, and since Node 18.20 execFile refuses one
    // directly (EINVAL). `cmd.exe /c` runs it with the args still passed as an
    // array -- `shell: true` would concatenate them unescaped (DEP0190) instead.
    const win = process.platform === 'win32';
    const out = exec(
      win ? process.env.COMSPEC || 'cmd.exe' : 'paseo',
      win ? ['/c', 'paseo.cmd', 'ls', '--json'] : ['ls', '--json'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    );
    const parsed = JSON.parse(out);
    if (parsed?.error) return { ok: false, reason: parsed.error.code || 'paseo error' };
    const rows = Array.isArray(parsed) ? parsed : parsed.agents || [];
    return { ok: true, value: rows.map(normaliseAgent) };
  } catch (e) {
    return { ok: false, reason: e?.code === 'ETIMEDOUT' ? 'paseo timed out' : 'paseo unreachable' };
  }
}

/** Agents registered as JSON files in `dir`. A missing folder means none are registered. */
export function filesLauncher({ dir = agentsDir(), now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!existsSync(dir)) return { ok: true, value: [] };
  try {
    const value = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let rec;
      try {
        rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        continue; // half-written file: skip it rather than fail the whole listing
      }
      const agent = normaliseAgent(rec);
      const seen = Date.parse(rec.updatedAt ?? rec.created ?? '');
      if (Number.isFinite(seen) && now - seen > staleAfterMs && ACTIVE_STATUSES.includes(agent.status.toLowerCase())) {
        // Not counted as active, but still attached to its folder, so a prune keeps it.
        agent.status = 'stale';
      }
      value.push(agent);
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: `cannot read ${dir}: ${e.message}` };
  }
}

const LAUNCHERS = { files: filesLauncher, paseo: paseoLauncher };

/** The running agents, from whichever launcher is configured. */
export function listAgents(opts = {}) {
  const name = opts.launcher || resolveLauncherName(opts);
  const fn = LAUNCHERS[name];
  if (!fn) return { ok: false, reason: `unknown launcher: ${name}` };
  return { ...fn(opts), launcher: name };
}

/** Write or refresh this agent's registration file (files launcher). */
export function registerAgent({ id, name, provider = '', status = 'running', cwd = process.cwd(), dir = agentsDir(), now = new Date() }) {
  if (!id || !/^[\w.-]+$/.test(id)) throw new Error('agent id must be letters, digits, dot, dash or underscore');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  let created = now.toISOString();
  try {
    created = JSON.parse(readFileSync(path, 'utf8')).created || created;
  } catch {
    // first registration
  }
  const rec = { id, name: name || id, provider, status, cwd, created, updatedAt: now.toISOString() };
  writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

/** Remove this agent's registration file (files launcher). */
export function unregisterAgent({ id, dir = agentsDir() }) {
  if (!id || !/^[\w.-]+$/.test(id)) throw new Error('agent id must be letters, digits, dot, dash or underscore');
  rmSync(join(dir, `${id}.json`), { force: true });
}
