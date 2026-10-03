/**
 * Review policy shared by scripts/dispatch-triage.mjs and scripts/swarm-map.mjs.
 *
 * Review pairing policy: a frontier model does not
 * review another frontier model's work. Mandatory apex review applies to work
 * authored BELOW T0; T0-authored work is gated by the two-axis review, the fixes
 * and verified test output.
 */

// T0 authors, matched as substrings so provider prefixes and harness routes
// (`claude/claude-fable-5-1`, `cursor/claude-fable-5-1`, `codex/gpt-6-astra`) all hit.
export const FRONTIER_AUTHOR_MARKERS = ['claude-fable-5-1', 'gpt-6-astra'];

export const TWO_AXIS_GATE = 'two_axis_review';

export function isFrontierAuthor(author) {
  if (typeof author !== 'string' || !author.trim()) return false;
  const a = author.trim().toLowerCase();
  return FRONTIER_AUTHOR_MARKERS.some(m => a.includes(m));
}

/**
 * @param {object} o
 * @param {number|undefined|null} o.apexProbability  Jev noul for "needs apex sign-off"
 * @param {number} o.threshold                       caller's existing cut-off
 * @param {string} [o.author]                        model id of whoever wrote the change
 * @returns {{ required: boolean, waived: boolean, reason: string|null }}
 */
export function apexReviewDecision({ apexProbability, threshold, author }) {
  const risky = typeof apexProbability === 'number' && apexProbability >= threshold;
  if (risky && isFrontierAuthor(author)) {
    return {
      required: false,
      waived: true,
      reason: `author ${author} is T0: frontier does not review frontier; gate is the two-axis review + verified tests`,
    };
  }
  return { required: risky, waived: false, reason: null };
}
