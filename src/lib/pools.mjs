/**
 * Credit-pool health.
 *
 * The tier policy has credit pools as its columns, not vendors, because the
 * billing model is the fact that drives routing. One of those pools dies on a
 * schedule: OpenCode Go is a subscription with a monthly usage cap, and a
 * quota-dead agent gives no error -- it sits `running` forever with no pending
 * permission, so a dispatch to it is simply lost.
 *
 * Health is data (`roster/pools.json`), matched against a profile's runtime
 * binding. A binding that matches no declared pool is healthy: this file can only
 * ever mark something dead, never falsely condemn a pool nobody wrote down.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POOLS_PATH = join(REPO_ROOT, 'roster', 'pools.json');

/** @returns {Record<string, {provider?: string|null, model_prefix?: string, dead_until?: string, reason?: string}>} */
export function loadPools({ poolsPath = POOLS_PATH } = {}) {
  return JSON.parse(readFileSync(poolsPath, 'utf8')).pools;
}

/**
 * Which declared pool does this runtime binding draw credit from?
 *
 * @param {{provider?: string, model?: string}} binding
 * @param {object} pools
 * @returns {string|null} pool id, or null when the binding matches nothing declared
 */
export function poolOf(binding, pools) {
  if (!binding) return null;
  for (const [id, pool] of Object.entries(pools)) {
    if (id.startsWith('$')) continue;
    const providerOk = pool.provider == null || binding.provider === pool.provider;
    const modelOk = !pool.model_prefix || String(binding.model ?? '').startsWith(pool.model_prefix);
    if (providerOk && modelOk) return id;
  }
  return null;
}

/**
 * Dead only until `dead_until`. The cap resets, so the skip has to reset with it --
 * a hardcoded "Go is dead" would outlive the outage and quietly shrink the roster.
 *
 * @param {string|null} poolId
 * @param {object} pools
 * @param {Date} now  injected, never read from the clock inside a pure resolver
 */
export function isPoolDead(poolId, pools, now) {
  if (!poolId) return false;
  const pool = pools[poolId];
  if (!pool?.dead_until) return false;
  return new Date(now) < new Date(`${pool.dead_until}T23:59:59Z`);
}

/** True when this profile can be dispatched right now. */
export function isNodeHealthy(node, pools, now) {
  return !isPoolDead(poolOf(node?.binding, pools), pools, now);
}
