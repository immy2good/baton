/**
 * Roster resolver shared by scripts/dispatch-triage.mjs and scripts/swarm-map.mjs.
 *
 * Why this exists: letting the classifier pick the worker from a hardcoded list
 * of seats means the option list makes the decision. If only one seat's
 * description mentions a domain, every ticket in that domain routes to it --
 * even when that seat is a reviewer that must never write. The classifier can
 * only choose from what it is handed.
 *
 * The split now:
 *   - `roster/profiles.json` (or Paseo's `daemon.agentProfiles` when Paseo is the
 *     launcher) owns the runtime binding (provider, model, modeId, thinkingOptionId).
 *   - `roster/routing.json` owns policy: tier, family, and who may write,
 *     review or gate.
 *   - Jev answers the small questions it is good at (domain, risk, apex). It no
 *     longer picks the worker; this resolver does, deterministically.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFrontierAuthor, TWO_AXIS_GATE } from './review-policy.mjs';
import { loadPools, isNodeHealthy } from './pools.mjs';
import { resolveLauncherName } from './launcher.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTING_PATH = join(REPO_ROOT, 'roster', 'routing.json');
const SNAPSHOT_PATH = join(REPO_ROOT, 'roster', 'profiles.json');

export const BINDING_FIELDS = ['provider', 'model', 'modeId', 'thinkingOptionId'];

// Roles a profile may hold and still be handed a ticket. `research` produces a
// cited brief rather than code, so it is a worker too; `reviewer`, `apex` and
// `gate` alone are not -- that distinction is the whole point of this module.
export const DISPATCHABLE_ROLES = ['writer', 'research'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Agent profiles: `BATON_PROFILES` or `roster/profiles.json`. When Paseo is the
 * launcher, its live profiles win, because Paseo is where they are edited.
 * @returns {{ profiles: object[], source: 'paseo'|'file' }}
 */
export function loadProfiles({ configPath, snapshotPath, env = process.env } = {}) {
  const usePaseo = configPath || resolveLauncherName({ env }) === 'paseo';
  if (usePaseo) {
    const live = configPath || env.PASEO_CONFIG || join(homedir(), '.paseo', 'config.json');
    try {
      const cfg = readJson(live);
      const profiles = cfg?.daemon?.agentProfiles;
      if (Array.isArray(profiles) && profiles.length) {
        return { profiles, source: 'paseo' };
      }
    } catch {
      // no readable Paseo config (CI, fresh worktree) -- fall through to the file
    }
  }
  const file = snapshotPath || env.BATON_PROFILES || SNAPSHOT_PATH;
  return { profiles: readJson(file).profiles, source: 'file' };
}

export function loadRouting({ routingPath = ROUTING_PATH } = {}) {
  return readJson(routingPath);
}

/**
 * Join policy to binding. Throws when they disagree, because a routing id that no
 * longer names a profile is exactly the drift that produced the Astra dispatch --
 * it must fail loudly, not fall back to something plausible.
 */
export function loadRoster(opts = {}) {
  const routing = loadRouting(opts);
  const { profiles, source } = loadProfiles(opts);
  const byId = new Map(profiles.map(p => [p.id, p]));

  const nodes = new Map();
  const missing = [];
  for (const [id, policy] of Object.entries(routing.profiles)) {
    const profile = byId.get(id);
    if (!profile) {
      missing.push(id);
      continue;
    }
    nodes.set(id, {
      id,
      name: profile.name,
      tier: policy.tier,
      family: policy.family,
      roles: policy.roles,
      binding: Object.fromEntries(
        BINDING_FIELDS.filter(f => profile[f] !== undefined).map(f => [f, profile[f]])
      )
    });
  }
  if (missing.length) {
    throw new Error(
      `roster/routing.json names ${missing.length} profile id(s) absent from the ${source} profiles: ${missing.join(', ')}. ` +
      `Fix roster/routing.json, or add the profile to roster/profiles.json.`
    );
  }

  const roster = { routing, nodes, source };
  assertWriterSeatsCanWrite(roster);
  return roster;
}

/**
 * Every seat a writer can be resolved from must actually hold the `writer` role.
 *
 * This is the load-bearing invariant of the whole module and it must live HERE, in
 * code, not only in the test file: `roster/routing.json` is data, and a data edit
 * that points a writer seat at the apex profile would otherwise sail through until
 * someone happened to run the suite. That is how the original defect survived --
 * a rule that was written down but never executed.
 */
export function assertWriterSeatsCanWrite(roster) {
  const { routing } = roster;
  const seats = ['work_type_primary', 'domain_primary', 'risk_default'].flatMap(table =>
    Object.entries(routing[table])
      .filter(([key]) => !key.startsWith('$')) // `$comment` keys document the table, they are not seats
      .map(([key, id]) => [`${table}.${key}`, id])
  );

  // `fallbacks` and `gate.failsafe` are writer seats too: resolveHealthy hands a
  // ticket to whatever they name. Leaving them out would let a data edit point
  // the failsafe at the apex profile and route a ticket to the apex reviewer by the back
  // door -- the exact hole this function exists to close.
  // A fallback chain is checked against the ROLE CLASS of the seat it replaces, not
  // against `writer` blindly: `fallbacks` serves reviewer seats too (deepseek_plan
  // -> grok_plan), and a reviewer stepping sideways to another reviewer is correct.
  // What must never happen is a chain handing a writer's ticket to a seat that
  // cannot write.
  const roleOffenders = [];
  for (const [preferred, chain] of Object.entries(routing.fallbacks ?? {})) {
    if (preferred.startsWith('$')) continue;
    const from = roster.nodes.get(preferred);
    if (!from) continue;
    for (const id of chain) {
      const to = roster.nodes.get(id);
      const shares = to?.roles.some(r => from.roles.includes(r));
      if (!shares) {
        roleOffenders.push(
          `fallbacks.${preferred} -> ${id} (${preferred} holds [${from.roles.join(', ')}], ` +
          `${id} holds [${to?.roles.join(', ') ?? 'unknown profile'}] -- no role in common)`
        );
      }
    }
  }
  if (roleOffenders.length) {
    throw new Error(
      `roster/routing.json declares ${roleOffenders.length} fallback(s) that cannot do the job they fall back FROM: ` +
      `${roleOffenders.join('; ')}.`
    );
  }
  for (const id of Array.isArray(routing.gate?.failsafe) ? routing.gate.failsafe : [routing.gate?.failsafe]) {
    if (id) seats.push(['gate.failsafe', id]);
  }

  const offenders = seats
    .filter(([, id]) => !roster.nodes.get(id)?.roles.some(r => DISPATCHABLE_ROLES.includes(r)))
    .map(([seat, id]) => `${seat} -> ${id} (roles: ${roster.nodes.get(id)?.roles.join(', ') ?? 'unknown profile'})`);

  if (offenders.length) {
    throw new Error(
      `roster/routing.json routes work to ${offenders.length} seat(s) that cannot be dispatched as workers: ${offenders.join('; ')}. ` +
      `A reviewer-only profile (the apex seat) must never be dispatched as a worker -- that is the defect this check exists for.`
    );
  }
}

const node = (roster, id) => {
  const n = roster.nodes.get(id);
  if (!n) throw new Error(`roster: unknown profile id "${id}"`);
  return n;
};

/**
 * Walk a seat's declared fallback chain until a live one is found.
 *
 * Two rules from above this function:
 *   - The chain is declared in `roster/routing.json -> fallbacks`. This walks it; it does not invent an order, and
 *     it never climbs a tier looking for a healthier seat.
 *   - Policy: an unavailable model must NEVER block the work.
 *     A chain that runs out lands on `gate.failsafe`, and if even that pool is
 *     dead the seat is taken anyway, flagged `forced`. There is no path out of
 *     this function that returns nothing: a blocked dispatch and a lost one look
 *     identical from the outside, and a capped agent already sits `running`
 *     forever without erroring.
 *
 * @returns {{node: object, fallbackFrom: string|null, failsafeUsed: boolean, forced: boolean, reason: string|null}}
 */
export function resolveHealthy(roster, preferredId, { pools, now, dispatchable = true } = {}) {
  const chain = [preferredId, ...(roster.routing.fallbacks?.[preferredId] ?? [])];
  const ok = id => {
    const n = roster.nodes.get(id);
    if (!n) return false;
    if (dispatchable && !n.roles.some(r => DISPATCHABLE_ROLES.includes(r))) return false;
    return isNodeHealthy(n, pools, now);
  };

  for (const id of chain) {
    if (ok(id)) {
      return {
        node: node(roster, id),
        fallbackFrom: id === preferredId ? null : preferredId,
        failsafeUsed: false,
        forced: false,
        reason: id === preferredId ? null : `${preferredId} is on a dead credit pool; fell sideways to ${id}`
      };
    }
  }

  // "Never up a tier" binds the failsafe too. A T4 bulk seat whose chain is dead
  // must not land on a T2 workhorse -- that is falling UP, and it quietly spends
  // workhorse capacity on renames. Take the strongest failsafe that is no
  // stronger than the seat being replaced.
  const preferredRank = tierRank(roster.nodes.get(preferredId)?.tier);
  const candidates = failsafeIds(roster).map(id => node(roster, id));
  const sameOrWeaker = candidates.filter(n => tierRank(n.tier) >= preferredRank);
  const pick =
    sameOrWeaker.find(n => isNodeHealthy(n, pools, now)) ||
    candidates.find(n => isNodeHealthy(n, pools, now)) ||
    sameOrWeaker[0] ||
    candidates[0];

  const forced = !isNodeHealthy(pick, pools, now);
  return {
    node: pick,
    fallbackFrom: preferredId,
    failsafeUsed: true,
    forced,
    reason: forced
      ? `every seat in the chain from ${preferredId} is on a dead credit pool, including the failsafe ${pick.id}; dispatched anyway rather than blocking the work`
      : `every seat in the chain from ${preferredId} is on a dead credit pool; the failsafe ${pick.id} takes it`
  };
}

/** `gate.failsafe` is a tier-ordered list; a bare string is still accepted. */
export function failsafeIds(roster) {
  const f = roster.routing.gate.failsafe;
  return Array.isArray(f) ? f : [f];
}

/** T0 is strongest, so a HIGHER rank number means a weaker seat. */
export function tierRank(tier) {
  const n = Number(String(tier ?? '').replace(/^T/i, ''));
  return Number.isFinite(n) ? n : 99;
}

export function writerCandidates(roster) {
  return [...roster.nodes.values()].filter(n => n.roles.includes('writer'));
}

/**
 * Pick the writer.
 *
 * Precedence: work type (bulk/research/docs) -> domain primary -> risk default.
 * Domain beats the risk default because `domain_primary` names a specialist per
 * domain; risk only decides when no domain primary applies.
 */
export function resolveWriter(roster, { domain, riskScore = 1, workType = 'implement' } = {}) {
  const { routing } = roster;
  const band = riskScore >= routing.risk_threshold ? 'high' : 'low';
  const id =
    routing.work_type_primary[workType] ||
    routing.domain_primary[domain] ||
    routing.risk_default[band];

  return asWriter(roster, id);
}

/** Resolve an id and refuse it if it cannot be dispatched. Belt to loadRoster's braces. */
function asWriter(roster, id) {
  const n = node(roster, id);
  if (!n.roles.some(r => DISPATCHABLE_ROLES.includes(r))) {
    throw new Error(
      `roster: ${id} cannot be dispatched as a worker (roles: ${n.roles.join(', ')}; need one of ${DISPATCHABLE_ROLES.join(', ')}).`
    );
  }
  return n;
}

/**
 * Pick the reviewer for a writer.
 *
 * Invariants:
 *  - the apex profile is never the writer (it has no `writer` role, so
 *    resolveWriter cannot return it);
 *  - reviewer family !== writer family. The old `writer !== reviewer` test passed
 *    for Sol -> Astra, which is the same GPT family the policy rules out;
 *  - apex reviews only work authored below T0 (review-policy.mjs waives it);
 *  - risk >= threshold adds an independent cross-model voice, family-different
 *    from both the writer and the first reviewer.
 */
export function resolveReviewers(roster, { writer, requiresApex = false, riskScore = 1, pools = loadPools(), now = new Date() } = {}) {
  const { routing } = roster;
  const apex = node(roster, routing.gate.apex);
  const gate = node(roster, routing.gate.two_axis);

  let reviewer;
  let reason;
  // A review seat on a dead pool is worse than no reviewer: the dispatch still
  // claims it has one, and the agent sits `running` forever. Measured 2026-09-21:
  // every critical_systems and web_ui dispatch was naming deepseek_plan, on capped Go.
  const live = (n, why) => {
    if (isNodeHealthy(n, pools, now)) return { node: n, why };
    const h = resolveHealthy(roster, n.id, { pools, now, dispatchable: false });
    return { node: h.node, why: `${why}; ${h.reason}` };
  };

  let picked;
  if (requiresApex && apex.family !== writer.family) {
    picked = live(apex, 'apex review required and apex is family-different from the writer');
  } else if (requiresApex) {
    picked = live(gate, `apex review required but apex is the same family (${writer.family}) as the writer; the staff-engineer gate reviews instead`);
  } else if (gate.id !== writer.id && gate.family !== writer.family) {
    picked = live(gate, 'two-axis review at the staff-engineer gate');
  } else {
    picked = live(
      node(roster, routing.gate.cross_model[0]),
      'writer holds the gate seat or shares its family; a cross-model reviewer takes the axis'
    );
  }
  reviewer = picked.node;
  reason = picked.why;

  let crossModel = null;
  if (riskScore >= routing.risk_threshold) {
    // `cross_model[0]` (deepseek_plan) is on OpenCode Go, capped since 2026-09-20 --
    // an adversarial voice that never answers is worse than none, because the
    // dispatch still claims it has one.
    crossModel = routing.gate.cross_model
      .map(id => node(roster, id))
      .find(n =>
        n.family !== writer.family &&
        n.family !== reviewer.family &&
        isNodeHealthy(n, pools, now)
      ) || null;
  }

  return { reviewer, reason, crossModel };
}

/**
 * Full dispatch decision. Pure: give it Jev's answers, it gives you the pairing.
 *
 * @param {object} o
 * @param {string} o.domain        Jev `domain` choice
 * @param {number} o.riskScore     Jev `risk_score` 0-3
 * @param {string} [o.workType]    implement | bulk | research | docs
 * @param {boolean} [o.requiresApex]
 * @param {boolean} [o.apexWaived]
 * @param {string} [o.author]      explicit author model id, when one is known
 */
export function resolveDispatch({
  domain,
  riskScore = 1,
  workType = 'implement',
  requiresApex = false,
  apexWaived = false,
  author,
  roster = loadRoster(),
  pools = loadPools(),
  now = new Date(),
  activeNodes = 0
} = {}) {
  const preferred = resolveWriter(roster, { domain, riskScore, workType });
  const health = resolveHealthy(roster, preferred.id, { pools, now });
  const writer = health.node;

  // When no explicit author was passed, the resolved writer IS the author, so a T0
  // writer waives apex review the same way an explicit T0 --author does.
  const effectiveAuthor = author || writer.binding.model;
  const waivedByAuthor = requiresApex && isFrontierAuthor(effectiveAuthor);
  const apexStillRequired = requiresApex && !waivedByAuthor;

  const { reviewer, reason, crossModel } = resolveReviewers(roster, {
    writer,
    requiresApex: apexStillRequired,
    riskScore,
    pools,
    now
  });

  return {
    writer,
    reviewer,
    cross_model_reviewer: crossModel,
    writer_fallback_from: health.fallbackFrom,
    failsafe_used: health.failsafeUsed,
    failsafe_forced: health.forced,
    failsafe_reason: health.reason,
    // Capacity is a QUEUE signal, never a block: the seat is resolved either way,
    // and the caller decides when to start it.
    at_capacity: activeNodes >= (roster.routing.max_active_nodes ?? Infinity),
    max_active_nodes: roster.routing.max_active_nodes ?? null,
    gate: apexStillRequired ? 'apex' : TWO_AXIS_GATE,
    requires_apex_review: apexStillRequired,
    apex_waived: apexWaived || waivedByAuthor,
    apex_waived_reason: waivedByAuthor
      ? `author ${effectiveAuthor} is T0: frontier does not review frontier`
      : null,
    effective_author: effectiveAuthor,
    reviewer_reason: reason,
    family_split_valid: reviewer.family !== writer.family,
    roster_source: roster.source
  };
}

/** Resolve a retired four-seat id to its profile. Read-only compatibility. */
export function resolveLegacyId(roster, legacyId) {
  const id = roster.routing.legacy_aliases[legacyId];
  return id ? node(roster, id) : null;
}

/**
 * The wire shape both CLIs emit. Kept here so the two scripts cannot drift: the
 * runtime binding is the part that must never be dropped on the way to the launcher.
 */
export function formatReviewDiamond(dispatch) {
  return {
    writer: dispatch.writer.id,
    writer_binding: dispatch.writer.binding,
    writer_tier: dispatch.writer.tier,
    reviewer: dispatch.reviewer.id,
    reviewer_binding: dispatch.reviewer.binding,
    reviewer_reason: dispatch.reviewer_reason,
    cross_model_reviewer: dispatch.cross_model_reviewer?.id ?? null,
    gate: dispatch.gate,
    family_split_valid: dispatch.family_split_valid
  };
}
