/**
 * The confidence gate on Jev's triage answers.
 *
 * Issue #11: we recorded a confidence on every classification and thresholded
 * none of them. https://docs.typesafe.ai/patterns/intent-routing states the rule
 * plainly -- `if intent.confidence < 0.5: route_to_human` -- and the same for a
 * score. The live answer that prompted this: `risk_score` 2.43 at confidence 0.54,
 * probabilities {2: 0.55, 3: 0.44}. Jev was split between High and Critical; we
 * took 2.43 and dispatched.
 *
 * Two escalation triggers, both cheap and both deterministic:
 *   1. a `choice` whose confidence falls below the floor;
 *   2. a `score` whose top-two probabilities sit on opposite sides of a routing
 *      boundary -- the number is not the decision, the band is.
 *
 * Reasons are machine strings (`low_confidence:work_type`, `straddle:risk_score@3`)
 * so a launcher can branch on them and tests can assert on them without matching prose.
 */

/** Below this, a `choice` is not a routing decision. Straight from the pattern doc. */
export const CONFIDENCE_FLOOR = 0.5;

/**
 * One cut-off for the "needs apex sign-off" noul.
 *
 * It was 0.65 in dispatch-triage.mjs and 0.50 in swarm-map.mjs -- the same
 * question answered two ways depending on which CLI you happened to run. Neither
 * was calibrated; 0.50 is every other noul cut-off in this codebase and it fails
 * toward MORE review, which is the safe direction for an uncalibrated number.
 */
export const APEX_NOUL_THRESHOLD = 0.50;

/**
 * The cut-off for every OTHER noul (negative control, singletons, live terminal).
 * Same number, different question: naming it APEX_... at those call sites read as
 * though the apex reviewer had an opinion about a negative control.
 */
export const NOUL_FLOOR = 0.50;

/**
 * Risk bands that change what happens downstream: `risk >= 2` flags a cross-repo
 * contract and fires the cross-model reviewer; `risk >= 3` calls a human-held
 * singleton. A split across either is a split about the outcome.
 */
export const RISK_BOUNDARIES = [2, 3];

/**
 * How close the runner-up band must be before a straddle counts as a SPLIT.
 *
 * A literal "top two straddle a boundary" reading escalates {1: 0.88, 2: 0.07}:
 * the top two do sit either side of 2, but Jev is not remotely torn -- it is 88%
 * on band 1. Escalating that is how a gate becomes noise and gets switched off.
 * The live case this gate exists for, {2: 0.55, 3: 0.44}, has a ratio of 0.80.
 */
export const STRADDLE_RATIO = 0.5;

/** Choices whose confidence gates the route. Both feed resolveDispatch. */
export const GATED_CHOICES = ['domain', 'work_type'];

/** Top two keys of a probability map, numerically, highest first. */
function topTwo(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') return [];
  return Object.entries(probabilities)
    .map(([k, p]) => [Number(k), Number(p)])
    .filter(([k, p]) => Number.isFinite(k) && Number.isFinite(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
}

/**
 * @param {object} o
 * @param {object} o.answers            Jev answers: {domain, work_type, risk_score}
 * @param {number} [o.confidenceFloor]
 * @param {number[]} [o.riskBoundaries]
 * @returns {{escalate: boolean, reasons: string[], probabilities: object, confidences: object}}
 */
export function escalationDecision({
  answers = {},
  confidenceFloor = CONFIDENCE_FLOOR,
  riskBoundaries = RISK_BOUNDARIES,
  straddleRatio = STRADDLE_RATIO
} = {}) {
  const reasons = [];
  const probabilities = {};
  const confidences = {};

  for (const key of GATED_CHOICES) {
    const a = answers[key];
    if (!a) continue;
    probabilities[key] = a.probabilities ?? null;
    // An absent confidence is not a confident answer. Reading `undefined` as "fine"
    // is how this gate would fail open on a response-shape change.
    const c = typeof a.confidence === 'number' ? a.confidence : -1;
    confidences[key] = a.confidence ?? null;
    if (c < confidenceFloor) reasons.push(`low_confidence:${key}`);
  }

  const risk = answers.risk_score;
  if (risk) {
    probabilities.risk_score = risk.probabilities ?? null;
    confidences.risk_score = risk.confidence ?? null;
    const [first, second] = topTwo(risk.probabilities);
    const torn = first && second && first[1] > 0 && second[1] / first[1] >= straddleRatio;
    if (torn) {
      const lo = Math.min(first[0], second[0]);
      const hi = Math.max(first[0], second[0]);
      for (const boundary of riskBoundaries) {
        if (lo < boundary && hi >= boundary) reasons.push(`straddle:risk_score@${boundary}`);
      }
    }
  }

  return { escalate: reasons.length > 0, reasons, probabilities, confidences };
}

/**
 * The human-readable form of an escalation, shared by both CLIs.
 *
 * Their return SHAPES differ (the map's UI reads different keys from the CLI's
 * JSON), so each call site still builds its own object -- but the words the human
 * reads must not drift between the two, which is exactly what a copied string does.
 */
export function formatEscalation({ reasons = [], probabilities = {}, confidences = {} } = {}) {
  const lines = [`ESCALATE: Jev is not confident enough to route this (${reasons.join(', ')}).`];
  for (const [key, p] of Object.entries(probabilities)) {
    if (p) lines.push(`  ${key}: ${JSON.stringify(p)} (confidence ${confidences[key] ?? 'n/a'})`);
  }
  lines.push('No writer or reviewer assigned -- a human decides.');
  return lines.join('\n');
}
