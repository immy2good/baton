/**
 * How many agents are working right now.
 *
 * Kept out of roster.mjs on purpose: that module is pure, and this one reads the
 * world through the launcher. A resolver that reads the world cannot be tested
 * without one.
 *
 * Policy: at most `routing.max_active_nodes` concurrently active agents. Being
 * over the cap is a QUEUE signal, never a block -- the dispatch is still resolved
 * and still names its seat, and the caller decides when to start it.
 */
import { listAgents, ACTIVE_STATUSES } from './launcher.mjs';

export { ACTIVE_STATUSES };

/**
 * Live count of active agents, or null when the launcher cannot be read.
 *
 * null, not 0: "cannot see the agents" and "nothing is running" are different
 * facts, and reporting the second when the first is true would let an unbounded
 * number of dispatches through exactly when nobody can see them.
 *
 * @param {object} [opts] passed to listAgents (launcher, exec, dir, ...)
 */
export function countActiveNodes(opts = {}) {
  const res = listAgents(opts);
  if (!res.ok) return null;
  return res.value.filter(a => ACTIVE_STATUSES.includes(String(a.status).toLowerCase())).length;
}
