/**
 * Guards for the swarm map's destructive path: deciding that a worktree is
 * "parked" and may be removed.
 *
 * The failure this guards against: an auto-prune deleted a worktree out from under
 * a running agent. The agent lookup compared git's path (`C:/Users/<me>/...`) with
 * the launcher's home-abbreviated cwd (`~/...`) using ===, so no agent ever matched,
 * and every clean worktree without an open PR looked abandoned - including one
 * created minutes earlier whose agent had not committed yet.
 */
import { homedir } from 'node:os';

/**
 * Canonical form for comparing filesystem paths from different tools on Windows.
 * Launchers may abbreviate the home directory (`~\worktrees\...`) while git
 * prints it in full (`C:/Users/<me>/worktrees/...`), so `~` is expanded.
 */
export function normalisePath(p, home = homedir()) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/');
  if (s === '~' || s.startsWith('~/')) s = String(home || '').replace(/\\/g, '/') + s.slice(1);
  // Git Bash / MSYS form: /c/Users/... -> c:/Users/...
  s = s.replace(/^\/([a-zA-Z])\//, '$1:/');
  s = s.replace(/\/+/g, '/');
  if (s.length > 3) s = s.replace(/\/$/, '');
  return s.toLowerCase();
}

export function samePath(a, b) {
  const na = normalisePath(a);
  return na !== '' && na === normalisePath(b);
}

/** True when `child` is `parent` or lives underneath it (an agent may have cd'd into a subfolder). */
export function isPathInside(child, parent) {
  const c = normalisePath(child);
  const p = normalisePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '/');
}

/** The agent whose cwd is this worktree (or a folder inside it), or null. */
export function findAgentForWorktree(agents, worktreePath) {
  if (!Array.isArray(agents)) return null;
  return agents.find((a) => a && a.cwd && isPathInside(a.cwd, worktreePath)) || null;
}

// A worktree younger than this is never prunable: it is created before its agent
// attaches, and a fresh ticket worktree is by definition clean with no open PR.
export const MIN_PRUNE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Pure decision: may this parked worktree be removed?
 * Fails closed - anything unknown means "keep".
 *
 * @param {object} o
 * @param {boolean} o.isClean
 * @param {boolean} o.hasOpenPr
 * @param {object|null} o.agent          agent attached to the worktree, if any
 * @param {boolean} o.isProtected
 * @param {boolean} o.agentsKnown        false when the agent listing failed - absence proves nothing
 * @param {number|null} o.ageMs          ms since the worktree was created; null = unknown
 * @param {number} [o.minAgeMs]
 * @returns {{ safe: boolean, reason: string }}
 */
export function pruneDecision({ isClean, hasOpenPr, agent, isProtected, agentsKnown, ageMs, minAgeMs = MIN_PRUNE_AGE_MS }) {
  if (!isClean) return { safe: false, reason: 'Uncommitted work' };
  if (hasOpenPr) return { safe: false, reason: 'Open PR' };
  if (isProtected) return { safe: false, reason: 'Protected branch' };
  if (agent) return { safe: false, reason: 'Agent attached' };
  if (!agentsKnown) return { safe: false, reason: 'Agent list unavailable - cannot prove the worktree is unattended' };
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return { safe: false, reason: 'Worktree age unknown' };
  if (ageMs < minAgeMs) return { safe: false, reason: `Younger than ${Math.round(minAgeMs / 3600000)}h - may be waiting for its agent` };
  return { safe: true, reason: 'Clean branch, no open PR, no agent, old enough' };
}
