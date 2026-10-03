import { choice, noul, queryJev, projectState } from './typesafe.mjs';

/**
 * Example cross-repository contract boundaries. Replace these with your own:
 * each one names the files that carry a shared contract and the repos that depend on it.
 */
export const KNOWN_CONTRACTS = {
  ipc_protocol: {
    name: "Desktop IPC Protocol",
    description: "Commands, events, ticket actions and heartbeats exchanged between a native plugin and a desktop app",
    patterns: [/bridge/i, /ipc/i, /setup[_-]?line/i, /ticket[_-]?action/i, /named[_-]?pipe/i],
    siblings: ["plugin-host", "desktop-app"]
  },
  licensing_auth: {
    name: "Licensing & Auth API",
    description: "License activation and heartbeat endpoints, product codes, token validation, and trial issuance",
    patterns: [/licens/i, /product[_-]?code/i, /heartbeat/i, /activation[_-]?token/i],
    siblings: ["api-server", "client-sdk"]
  },
  shared_schema: {
    name: "Shared Data Schema",
    description: "Database migrations, shared enums, and exported data shapes other services read",
    patterns: [/migrations?\//i, /ALTER TABLE/i, /\benum\b/i, /export[_-]?type/i],
    siblings: ["api-server", "web-app"]
  },
  agent_environment: {
    name: "Agent Worktree & Mail Environment",
    description: "Worktree environment contract, config/agent-mail.json, and launcher agent bindings",
    patterns: [/agent-mail/i, /roster/i, /baton\.json/i, /worktree/i],
    siblings: ["baton"]
  }
};

/**
 * Strips newlines and control characters to guarantee strict two-line formatting.
 */
function cleanInline(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/**
 * Deterministically check which cross-repo contracts are touched by file paths or text.
 */
export function identifyTouchedContracts(textOrPaths) {
  const input = Array.isArray(textOrPaths) ? textOrPaths.join(' ') : String(textOrPaths || '');
  const touched = [];

  for (const [key, contract] of Object.entries(KNOWN_CONTRACTS)) {
    const matched = contract.patterns.some(pattern => pattern.test(input));
    if (matched) {
      touched.push({
        id: key,
        name: contract.name,
        description: contract.description,
        siblings: contract.siblings
      });
    }
  }

  return touched;
}

/**
 * Format an 2-line executive verdict for contract drift.
 * Guarantees exactly two lines by sanitizing all interpolated values.
 */
export function formatContractDriftSummary({ driftDetected, isBreaking, category, contract, siblings = [], confidence }) {
  let verdictLine = "";
  let actionLine = "";

  const cleanContract = cleanInline(contract || 'shared contract');
  const confStr = typeof confidence === 'number' ? ` (confidence: ${confidence.toFixed(2)})` : "";
  const siblingStr = siblings.length > 0 ? ` (${siblings.join(', ')})` : "";

  if (driftDetected && isBreaking) {
    verdictLine = `Verdict: Breaking contract drift detected in ${cleanContract}${confStr}.`;
    actionLine = `Next Action: Add backward compatibility adapter or create coordinated cross-repo ticket.`;
  } else if (category === "requires_contract_review") {
    verdictLine = `Verdict: Shared contract boundary touched in ${cleanContract}${confStr}.`;
    actionLine = `Next Action: Run sibling contract verification${siblingStr} before merge.`;
  } else if (driftDetected && !isBreaking) {
    verdictLine = `Verdict: Non-breaking additive contract evolution in ${cleanContract}${confStr}.`;
    actionLine = `Next Action: Verify consumer tolerance in sibling tests before merge.`;
  } else {
    verdictLine = `Verdict: No cross-repo contract drift detected${confStr}.`;
    actionLine = `Next Action: Safe to proceed within repository worktree boundary.`;
  }

  return {
    verdict: cleanInline(verdictLine),
    next_action: cleanInline(actionLine),
    formatted: `${cleanInline(verdictLine)}\n${cleanInline(actionLine)}`
  };
}

/**
 * Semantically audit a patch or specification for cross-repo contract drift using Jev.
 * Governed by deterministic boundary checks: Jev cannot clear a detected shared contract surface.
 */
export async function auditContractDrift(diffOrDescription, options = {}) {
  const touched = identifyTouchedContracts(diffOrDescription);
  const contractContext = touched.map(c => `${c.name}: ${c.description}`).join('; ');

  // Allowlist project the input state
  const state = projectState({
    context: options.context || "Cross-repo contract audit",
    target_contracts: contractContext || "General shared boundary",
    diff_or_description: typeof diffOrDescription === 'string' ? diffOrDescription.slice(0, 15000) : JSON.stringify(diffOrDescription).slice(0, 15000)
  });

  const questions = {
    touches_shared_contract: noul(
      "Does this proposed change modify an API contract, wire format, command protocol, or buffer mapping shared across multiple repositories?"
    ),
    is_breaking_change: noul(
      "Does this modification break backward compatibility for existing consumers without an explicit deprecation or versioning fallback?"
    ),
    drift_category: choice("What type of contract modification is occurring?", {
      no_drift: "Internal implementation detail with no cross-repo contract impact",
      backward_compatible: "Additive modification (e.g. optional parameter, new event) that preserves existing callers",
      breaking_drift: "Breaking change (e.g. renamed field, shifted buffer index, altered command payload, modified auth format)"
    })
  };

  const queryFn = options.queryJevFn || queryJev;
  const { answers, latencyMs, usage, model } = await queryFn(state, questions, {
    timeoutMs: options.timeoutMs ?? 5000
  });

  const touchesShared = answers.touches_shared_contract?.noul ?? 0;
  const isBreaking = answers.is_breaking_change?.noul ?? 0;
  const rawCategory = answers.drift_category?.choice ?? "no_drift";

  // Programmatic circuit breaker ("Code Governs, Jev Judges")
  let finalCategory = rawCategory;
  if (isBreaking >= 0.55 || rawCategory === "breaking_drift") {
    finalCategory = "breaking_drift";
  } else if (rawCategory === "backward_compatible" && (touchesShared >= 0.40 || touched.length > 0)) {
    finalCategory = "backward_compatible";
  } else if (touched.length > 0) {
    // Deterministic circuit breaker: Jev cannot clear a known touched boundary to "no_drift"
    finalCategory = "requires_contract_review";
  } else if (touchesShared < 0.35) {
    finalCategory = "no_drift";
  }

  const driftDetected = finalCategory !== "no_drift";
  const breaking = finalCategory === "breaking_drift";

  const primaryContract = touched.length > 0 ? touched[0].name : "shared interface";
  const primarySiblings = touched.length > 0 ? touched[0].siblings : [];

  const briefSummary = formatContractDriftSummary({
    driftDetected,
    isBreaking: breaking,
    category: finalCategory,
    contract: primaryContract,
    siblings: primarySiblings,
    confidence: answers.drift_category?.confidence
  });

  return {
    drift_detected: driftDetected,
    is_breaking: breaking,
    category: finalCategory,
    confidence: answers.drift_category?.confidence ?? 0.5,
    touched_contracts: touched,
    metrics: {
      touches_shared_contract_prob: touchesShared,
      is_breaking_prob: isBreaking
    },
    summary: briefSummary,
    meta: {
      latency_ms: latencyMs,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      model
    }
  };
}
