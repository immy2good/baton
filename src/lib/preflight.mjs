import {
  choice,
  score,
  noul,
  queryJev,
  projectState,
  createDecisionTrace,
  PINNED_PRODUCTION_MODEL
} from './typesafe.mjs';

/**
 * Question definitions for batched issue intake preflight.
 */
export const PREFLIGHT_QUESTIONS = {
  domain: choice("What domain does this task belong to?", {
    critical_systems: "Payments, money movement, order execution, or any code where a bug costs real money",
    auth_security: "Authentication, licensing, permissions, tokens, webhooks",
    web_ui: "Web front-ends, themes, landing pages, CSS layout, copy",
    infrastructure: "Agent tooling, launcher configs, schemas, CI/CD, scripts"
  }),
  work_kind: choice("What kind of work is this?", {
    bugfix: "Fixing an existing defect or regression",
    feature: "Building new capability or extending functionality",
    refactor: "Structural improvements preserving existing behavior",
    docs: "Documentation, decision records, runbooks, or handoff notes",
    research: "Answering questions from primary sources; analysis brief",
    infrastructure: "Bus, harness, tool, CI, or dev environment changes"
  }),
  risk_score: score("Rate the operational and financial risk of modifying this code", [
    "Negligible risk (docs, comments, mechanical test rename)",
    "Low to medium risk (isolated UI styling, non-critical helper)",
    "High risk (shared contracts, auth or licensing logic, installer packaging)",
    "Critical risk (money movement, production data, secrets)"
  ]),
  touches_critical_path: noul(
    "Does this task touch money movement, payments, order execution, or other code where a bug costs real money?"
  ),
  touches_cross_repo_contract: noul(
    "Does this task touch or modify contracts shared across repos (e.g. API payloads, wire protocols, shared IDs)?"
  ),
  requires_human_approval: noul(
    "Does this task touch human-held singletons, production secrets, hosting, or live deployment?"
  ),
  ac_missing: noul(
    "Is the acceptance criteria or desired outcome noticeably ambiguous, incomplete, or underspecified?"
  ),
  requires_negative_control: noul(
    "Does acceptance of this task require proving a defect failed first with a negative control?"
  ),
  requires_live_environment: noul(
    "Does verifying this task require a real device, terminal, or external runtime rather than tests alone?"
  )
};

/**
 * Strips newlines and control characters to guarantee strict two-line formatting.
 */
function cleanInline(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/**
 * Formats a 2-line executive summary from preflight flags and probabilities.
 * 
 * Line 1: Verdict (Risk level | Domain | Primary hazard/character)
 * Line 2: Next Action (Clear, concise next instruction)
 */
export function formatTwoLineSummary({
  riskScore,
  domain,
  workKind,
  flags,
  probabilities,
  confidence = 0.85
}) {
  let hazard = "Normal Scoped Work";
  let nextAction = "Proceed directly to test-driven implementation on workhorse worker.";

  if (flags.requires_human_approval) {
    hazard = "Singleton / Production Hazard";
    nextAction = "Escalate to a human: requires singleton or production deployment approval.";
  } else if (flags.ac_missing) {
    hazard = "Ambiguous Requirements / Missing AC";
    nextAction = "Clarify desired outcome and acceptance criteria before starting code implementation.";
  } else if (flags.touches_critical_path) {
    hazard = "Critical Path Risk";
    nextAction = "Inspect the critical path and its contracts; mandatory different-family review.";
  } else if (flags.touches_cross_repo_contract) {
    hazard = "Cross-Repo Contract Surface";
    nextAction = "Inspect sibling repo ABI/contract definitions before writing code.";
  } else if (flags.requires_negative_control) {
    hazard = "Defect Fix Requiring Proof";
    nextAction = "Author and prove negative control test failure before writing fix.";
  } else if (riskScore === 0) {
    hazard = "Negligible Risk";
    nextAction = "Dispatch to T3/T4 fast worker for quick completion.";
  }

  const riskLabel = ["Negligible", "Low-Medium", "High", "Critical"][riskScore] || "Moderate";
  const confStr = typeof confidence === 'number' ? confidence.toFixed(2) : "0.85";

  const cleanDomain = cleanInline(domain);
  const cleanWorkKind = cleanInline(workKind);

  const verdict = cleanInline(`Verdict: ${riskLabel} Risk (${riskScore}/3) | ${cleanDomain}:${cleanWorkKind} | ${hazard} (Confidence: ${confStr})`);
  const actionLine = cleanInline(`Next Action: ${nextAction}`);

  return {
    verdict,
    next_action: actionLine,
    formatted: `${verdict}\n${actionLine}`
  };
}

/**
 * Evaluates an incoming task or issue in a single batched speculative System One call.
 * 
 * @param {object|string} input - Issue or task details ({ title, description, repo, baseline_risk })
 * @param {object} [options]
 * @param {string} [options.apiKey]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.queryJevFn] - Optional mock/transport injector
 * @returns {Promise<object>} Structured preflight assessment
 */
export async function evaluatePreflight(input, options = {}) {
  let title = '';
  let description = '';
  let repo = '';
  let baselineRisk = undefined;

  if (typeof input === 'string') {
    title = input;
    description = options.description || options.desc || '';
  } else if (input && typeof input === 'object') {
    title = input.title || '';
    description = input.description || input.desc || '';
    repo = input.repo || '';
    baselineRisk = input.baseline_risk ?? input.baselineRisk;
  }

  const rawState = {
    title,
    description,
    repo: repo || 'unknown',
    timestamp: new Date().toISOString()
  };

  const sanitizedState = projectState(rawState, {
    allowlist: ['title', 'description', 'repo', 'timestamp']
  });

  const queryFn = options.queryJevFn || queryJev;
  const t0 = performance.now();
  const resp = await queryFn(sanitizedState, PREFLIGHT_QUESTIONS, {
    model: PINNED_PRODUCTION_MODEL,
    timeoutMs: options.timeoutMs ?? 5000,
    apiKey: options.apiKey
  });
  const latencyMs = Math.round(performance.now() - t0);

  const answers = resp.answers || {};
  const domain = answers.domain?.choice || 'infrastructure';
  const workKind = answers.work_kind?.choice || 'feature';
  const riskScore = answers.risk_score?.score ?? 1;

  const probabilities = {
    critical_path: answers.touches_critical_path?.noul ?? 0,
    cross_repo_contract: answers.touches_cross_repo_contract?.noul ?? 0,
    human_approval: answers.requires_human_approval?.noul ?? 0,
    ac_missing: answers.ac_missing?.noul ?? 0,
    negative_control: answers.requires_negative_control?.noul ?? 0,
    live_environment: answers.requires_live_environment?.noul ?? 0
  };

  const flags = {
    touches_critical_path: probabilities.critical_path >= 0.5,
    touches_cross_repo_contract: probabilities.cross_repo_contract >= 0.5,
    requires_human_approval: probabilities.human_approval >= 0.5,
    ac_missing: probabilities.ac_missing >= 0.5,
    requires_negative_control: probabilities.negative_control >= 0.5,
    requires_live_environment: probabilities.live_environment >= 0.5
  };

  // Average confidence of choice & score answers if available
  const conf1 = answers.domain?.confidence ?? 0.85;
  const conf2 = answers.work_kind?.confidence ?? 0.85;
  const avgConfidence = Math.round(((conf1 + conf2) / 2) * 100) / 100;

  const briefSummary = formatTwoLineSummary({
    riskScore,
    domain,
    workKind,
    flags,
    probabilities,
    confidence: avgConfidence
  });

  // Disagreement detection against deterministic baseline
  let disagreement = null;
  if (typeof baselineRisk === 'number') {
    const delta = Math.abs(riskScore - baselineRisk);
    if (delta >= 1) {
      disagreement = {
        type: 'risk_disagreement',
        title,
        jev_risk: riskScore,
        baseline_risk: baselineRisk,
        delta,
        severity: delta >= 2 ? 'high' : 'medium',
        logged_at: new Date().toISOString()
      };
    }
  }

  const trace = createDecisionTrace({
    decisionType: 'intake_preflight',
    model: resp.model || PINNED_PRODUCTION_MODEL,
    latencyMs,
    status: 'ok',
    answers,
    usage: resp.usage
  });

  return {
    title,
    domain,
    work_kind: workKind,
    risk_score: riskScore,
    flags,
    probabilities,
    summary: briefSummary,
    disagreement,
    trace,
    meta: {
      latency_ms: latencyMs,
      model: resp.model || PINNED_PRODUCTION_MODEL,
      usage: resp.usage
    }
  };
}
