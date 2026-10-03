#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { choice, noul, queryJev, projectState } from '../src/lib/typesafe.mjs';

const VALID_NODES = new Set(["cursor", "claude", "opencode", "antigravity", "codex", "perplexity", "dispatcher"]);
const VALID_OUTCOMES = new Set(["done", "blocked", "handed_off", "failed_start"]);
const ALLOWED_PROPERTIES = new Set([
  "schema_version",
  "ticket",
  "node",
  "outcome",
  "commit",
  "branch",
  "verified",
  "not_verified",
  "capture"
]);

const SHA_REGEX = /^[0-9a-fA-F]{7,40}$/;
const EXEC_COMMAND_REGEX = /\b(?:(?:ran|executed|running|invoked)\s+(?:scripts?\/[^\s,;]+\.[a-zA-Z0-9]+|tests?\/[^\s,;]+\.[a-zA-Z0-9]+|[^\s,;]+\.(?:ps1|sh|mjs|py|ts|js)|npm\s+test|npm\s+run\s+[a-zA-Z0-9_\-:]+|node\s+--test(?:\s+(?!-)[^\s,;]+)?|pytest(?:\s+(?!-)[^\s,;]+)?|cargo\s+test|pwsh\s+-File\s+(?!-)(?:scripts?\/[^\s,;]+|tests?\/[^\s,;]+|[^\s,;]+\.ps1|\.{1,2}\/[^\s,;]+)|bash\s+(?!-)(?:scripts?\/[^\s,;]+|tests?\/[^\s,;]+|[^\s,;]+\.(?:sh|bash)|\.{1,2}\/[^\s,;]+))|node\s+--test(?:\s+(?!-)[^\s,;]+)?|npm\s+test|npm\s+run\s+[a-zA-Z0-9_\-:]+|pytest(?:\s+(?!-)[^\s,;]+)?|cargo\s+test|pwsh\s+-File\s+(?!-)(?:scripts?\/[^\s,;]+|tests?\/[^\s,;]+|[^\s,;]+\.ps1|\.{1,2}\/[^\s,;]+)|bash\s+(?!-)(?:scripts?\/[^\s,;]+|tests?\/[^\s,;]+|[^\s,;]+\.(?:sh|bash)|\.{1,2}\/[^\s,;]+))\b/i;
const EXEC_ASSERTION_REGEX = /\b(?:exit\s*(?:code\s*)?0|all\s+\d+\s+(?:tests?|specs?)\s+pass(?:ed|ing)?|\b\d+\s+pass(?:ed|ing)?|\b0\s+fail(?:ures|ed)?|assert(?:ion)?s?\s+pass(?:ed)?)\b/i;

const NEG_MUTATION_REGEX = /(?:revert(?:ing|ed)?\s+(?:commit\s+[0-9a-fA-F]+|the\s+fix|code)|without\s+(?:the\s+)?fix|before\s+(?:applying\s+)?(?:the\s+)?fix|mutat(?:ed|ing)\s+[^,\n]+|defect\s+reproduced)/i;
const NEG_FAILURE_REGEX = /(?:caused\s+(?:test|run|assertion|build|execution)\s+[^,\n]*\s+to\s+fail|failed\s+with\s+(?:error|code|exit\s*[1-9]|assert)|test\s+failed\s+as\s+expected|causes?\s+(?:a\s+)?failure)/i;
const SINGLETON_VIOLATION_REGEX = /(?:deploy(?:ed)?\s+(?:directly\s+)?to\s+prod|live\s+cms|ssh\s+production|signing\s+license)/i;

/**
 * Strips newlines and control characters to guarantee strict two-line formatting.
 */
function cleanInline(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/**
 * Checks whether an evidence string constitutes substantive, machine-checkable execution proof.
 * Requires BOTH an execution command/runner AND a concrete assertion/exit result.
 */
export function isExecutableEvidence(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.length < 12 || trimmed.split(/\s+/).length < 3) {
    return false;
  }
  return EXEC_COMMAND_REGEX.test(trimmed) && EXEC_ASSERTION_REGEX.test(trimmed);
}

/**
 * Checks whether an evidence string constitutes concrete negative control verification.
 * Requires BOTH a mutation/revert action AND an observed defect failure.
 */
export function isNegativeControlEvidence(str) {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.length < 20 || trimmed.split(/\s+/).length < 4) {
    return false;
  }
  return NEG_MUTATION_REGEX.test(trimmed) && NEG_FAILURE_REGEX.test(trimmed);
}

/**
 * Deterministically validate receipt against schema and proof requirements before invoking LLM.
 */
export function validateReceiptSchema(data, options = {}) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ["Receipt must be a JSON object"] };
  }

  // Reject unexpected properties
  for (const prop of Object.keys(data)) {
    if (!ALLOWED_PROPERTIES.has(prop)) {
      errors.push(`Unexpected property not in schema: "${prop}"`);
    }
  }

  if (data.schema_version !== 1) {
    errors.push(`Invalid or missing schema_version: expected 1, got ${data.schema_version}`);
  }
  if (!data.ticket || typeof data.ticket !== 'string' || data.ticket.trim().length === 0) {
    errors.push("Missing or empty ticket field");
  }
  if (!VALID_NODES.has(data.node)) {
    errors.push(`Invalid node: "${cleanInline(data.node)}". Expected one of: ${Array.from(VALID_NODES).join(', ')}`);
  }
  if (!VALID_OUTCOMES.has(data.outcome)) {
    errors.push(`Invalid outcome: "${cleanInline(data.outcome)}". Expected one of: ${Array.from(VALID_OUTCOMES).join(', ')}`);
  }

  // Optional properties when present must strictly satisfy their types
  if (data.commit !== undefined) {
    if (typeof data.commit !== 'string' || !SHA_REGEX.test(data.commit.trim())) {
      errors.push(`commit property must be a valid hex SHA (7-40 hex chars), got: ${typeof data.commit === 'string' ? `"${cleanInline(data.commit)}"` : typeof data.commit}`);
    }
  }

  if (data.branch !== undefined) {
    if (typeof data.branch !== 'string' || data.branch.trim().length === 0) {
      errors.push(`branch property must be a non-empty string, got: ${typeof data.branch === 'string' ? '""' : typeof data.branch}`);
    }
  }

  // Verified array validation
  if (!Array.isArray(data.verified)) {
    errors.push("Missing or invalid verified array");
  } else {
    for (let i = 0; i < data.verified.length; i++) {
      const item = data.verified[i];
      if (typeof item !== 'string' || item.trim().length === 0) {
        errors.push(`verified[${i}] must be a non-empty string`);
      }
    }
  }

  // Not_verified array validation
  if (!Array.isArray(data.not_verified)) {
    errors.push("Missing or invalid not_verified array");
  } else {
    for (let i = 0; i < data.not_verified.length; i++) {
      const item = data.not_verified[i];
      if (typeof item !== 'string') {
        errors.push(`not_verified[${i}] must be a string`);
      }
    }
  }

  if (!data.capture || typeof data.capture !== 'string' || data.capture.trim().length === 0) {
    errors.push("Missing or empty capture field");
  }

  // Outcome-specific requirements for 'done'
  if (data.outcome === 'done') {
    if (!data.commit) {
      errors.push("Completed outcome requires a valid commit SHA (7-40 hex chars)");
    }
    if (!data.branch) {
      errors.push("Completed outcome requires a non-empty branch name");
    }
    if (Array.isArray(data.verified) && data.verified.length === 0) {
      errors.push("Completed outcome requires at least one verified evidence item");
    }

    // Deterministic machine-checkable proof check
    if (Array.isArray(data.verified) && data.verified.length > 0) {
      const hasExecProof = data.verified.some(v => isExecutableEvidence(v));
      if (!hasExecProof) {
        errors.push("Evidence missing executable proof: verified items must cite commands, exit status, or test runner output");
      }
      if (options.requireNegativeControl) {
        const hasNegCtrl = data.verified.some(v => isNegativeControlEvidence(v));
        if (!hasNegCtrl) {
          errors.push("Negative control missing: verification must prove defect prior to fix or failure on revert");
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Format an 2-line executive verdict for a receipt audit.
 * Guarantees exactly two lines by sanitizing all interpolated components.
 */
export function formatReceiptSummary({ passed, verdict, reasons, unfoolableProof = 0, negativeControl = 0, singletonBreach = 0 }) {
  let verdictLine = "";
  let actionLine = "";

  if (verdict === "alarm_singleton_breach" || singletonBreach >= 0.70) {
    verdictLine = `Verdict: ALARM - Human-held singleton breach detected ($p=${singletonBreach.toFixed(2)}).`;
    actionLine = `Next Action: Revert live production/deployment claims immediately. Singletons belong strictly to a human.`;
  } else if (!passed) {
    const rawReason = reasons && reasons.length > 0 ? reasons[0] : "Insufficient proof";
    const cleanReason = cleanInline(rawReason);
    verdictLine = `Verdict: Rejected - ${cleanReason}.`;
    if (negativeControl < 0.35 || cleanReason.includes("Negative control")) {
      actionLine = `Next Action: Revert fix, run failing test to prove defect, and capture output in verified array.`;
    } else {
      actionLine = `Next Action: Add concrete terminal command output and test assertions to verified array.`;
    }
  } else {
    verdictLine = `Verdict: Approved (Proof confidence: ${unfoolableProof.toFixed(2)}, negative control: ${negativeControl.toFixed(2)}).`;
    actionLine = `Next Action: Safe to merge branch into develop.`;
  }

  return {
    verdict: cleanInline(verdictLine),
    next_action: cleanInline(actionLine),
    formatted: `${cleanInline(verdictLine)}\n${cleanInline(actionLine)}`
  };
}

/**
 * Semantic gatekeeper for Agent Bus GitHub Receipts.
 * Evaluates whether an agent's receipt proves completion with unfoolable evidence
 * and respects swarm invariants (negative controls, singleton boundaries).
 */
export async function auditReceipt(receiptData, options = {}) {
  // 1. Deterministic Singleton Circuit Breaker (Highest priority swarm alarm)
  if (receiptData && typeof receiptData === 'object' && Array.isArray(receiptData.verified)) {
    for (const item of receiptData.verified) {
      if (typeof item === 'string' && SINGLETON_VIOLATION_REGEX.test(item)) {
        const breachReasons = [`Deterministic singleton breach detected: "${cleanInline(item)}"`];
        return {
          passed: false,
          verdict: "alarm_singleton_breach",
          confidence: 1.0,
          metrics: {
            unfoolable_proof_probability: 0.0,
            negative_control_probability: 0.0,
            singleton_breach_probability: 1.0
          },
          reasons: breachReasons,
          summary: formatReceiptSummary({
            passed: false,
            verdict: "alarm_singleton_breach",
            singletonBreach: 1.0,
            reasons: breachReasons
          }),
          meta: {
            latency_ms: 0,
            deterministic: true,
            tokens_in: 0,
            tokens_out: 0
          }
        };
      }
    }
  }

  // 2. Deterministic Schema & Proof Pre-validation ("Code Governs")
  const schemaCheck = validateReceiptSchema(receiptData, options);
  if (!schemaCheck.valid) {
    const summary = formatReceiptSummary({
      passed: false,
      verdict: "reject_insufficient_proof",
      reasons: schemaCheck.errors
    });
    return {
      passed: false,
      verdict: "reject_insufficient_proof",
      confidence: 1.0,
      metrics: {
        unfoolable_proof_probability: 0.0,
        negative_control_probability: 0.0,
        singleton_breach_probability: 0.0
      },
      reasons: schemaCheck.errors,
      summary: summary,
      meta: {
        latency_ms: 0,
        deterministic: true,
        tokens_in: 0,
        tokens_out: 0
      }
    };
  }

  // 3. Allowlist project state for semantic Jev evaluation
  const state = projectState({
    ticket: receiptData.ticket,
    node: receiptData.node,
    outcome: receiptData.outcome,
    commit: receiptData.commit,
    branch: receiptData.branch,
    verified: receiptData.verified,
    not_verified: receiptData.not_verified,
    capture: receiptData.capture
  });

  const questions = {
    has_unfoolable_proof: noul(
      "Does this receipt cite specific test scripts, executable commands, or concrete verification evidence (rather than subjective assertions like 'looks good')?"
    ),
    has_negative_control: noul(
      "Does this receipt demonstrate a negative control (e.g. verifying that a test failed prior to applying the fix, or that reverting the fix causes a failure)?"
    ),
    violated_human_approvals: noul(
      "Did this agent perform or claim a human-held singleton action (such as live production deployment, live CMS writes, or license signing)?"
    ),
    verdict: choice("What is the swarm governance gate verdict for this receipt?", {
      approve_merge: "Contains verified test results, test scripts or negative control evidence, and respects singletons",
      reject_insufficient_proof: "Lacks test execution evidence or contains purely subjective/speculative assertions",
      alarm_singleton_breach: "Attempted prohibited production deployment, live licensing, or singleton bypass"
    })
  };

  const queryFn = options.queryJevFn || queryJev;
  const { answers, latencyMs, usage, model } = await queryFn(state, questions, {
    timeoutMs: options.timeoutMs ?? 5000
  });

  const unfoolableProof = answers.has_unfoolable_proof?.noul ?? 0;
  const negativeControl = answers.has_negative_control?.noul ?? 0;
  const singletonBreach = answers.violated_human_approvals?.noul ?? 0;
  const rawVerdict = answers.verdict?.choice ?? "reject_insufficient_proof";

  // Programmatic circuit-breaker on top of model classification
  let finalVerdict = rawVerdict;
  let reasons = [];

  const requiresNegativeControl = options.requireNegativeControl ?? false;

  if (singletonBreach >= 0.70) {
    finalVerdict = "alarm_singleton_breach";
    reasons.push(`Singleton breach detected ($p=${singletonBreach.toFixed(2)}). Live production/license actions require a human.`);
  } else if (requiresNegativeControl && negativeControl < 0.35) {
    finalVerdict = "reject_insufficient_proof";
    reasons.push(`Negative control missing ($p=${negativeControl.toFixed(2)}). Verification failed to prove defect caught before fix.`);
  } else if (unfoolableProof < 0.35 || rawVerdict === "reject_insufficient_proof") {
    finalVerdict = "reject_insufficient_proof";
    reasons.push(`Hollow proof or missing execution evidence ($p=${unfoolableProof.toFixed(2)}). Evidence over assertion invariant failed.`);
  }

  const passed = finalVerdict === "approve_merge";

  const briefSummary = formatReceiptSummary({
    passed,
    verdict: finalVerdict,
    reasons,
    unfoolableProof,
    negativeControl,
    singletonBreach
  });

  return {
    passed,
    verdict: finalVerdict,
    confidence: answers.verdict?.confidence ?? 0.5,
    metrics: {
      unfoolable_proof_probability: unfoolableProof,
      negative_control_probability: negativeControl,
      singleton_breach_probability: singletonBreach
    },
    reasons,
    summary: briefSummary,
    meta: {
      latency_ms: latencyMs,
      tokens_in: usage?.input_tokens ?? 0,
      tokens_out: usage?.output_tokens ?? 0,
      model
    }
  };
}

async function main() {
  const options = {
    file: { type: 'string', short: 'f' },
    json: { type: 'boolean', short: 'j', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  };

  const { values, positionals } = parseArgs({
    options,
    allowPositionals: true,
    strict: false
  });

  if (values.help || (!values.file && positionals.length === 0)) {
    console.log(`
Usage:
  node scripts/receipt-gate.mjs <path/to/receipt.json> [--json]
  node scripts/receipt-gate.mjs -f docs/schemas/examples/receipt.valid.json

Options:
  -f, --file    Path to receipt.json file
  -j, --json    Output pure JSON for CI or hooks
  -h, --help    Show this help message
`);
    process.exit(0);
  }

  const filePath = values.file || positionals[0];
  let receiptContent;
  try {
    receiptContent = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read receipt file at "${filePath}": ${err.message}`);
    process.exit(1);
  }

  const result = await auditReceipt(receiptContent);

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== JEV RECEIPT GATE AUDIT ===`);
    console.log(`Receipt File:    ${filePath}`);
    console.log(`Gate Verdict:    ${result.verdict.toUpperCase()}`);
    console.log(`Unfoolable Proof: p(yes) = ${result.metrics.unfoolable_proof_probability.toFixed(2)}`);
    console.log(`Negative Control: p(yes) = ${result.metrics.negative_control_probability.toFixed(2)}`);
    console.log(`Singleton Breach: p(yes) = ${result.metrics.singleton_breach_probability.toFixed(2)}`);
    if (result.reasons.length > 0) {
      console.log(`Findings:        ${result.reasons.join(' | ')}`);
    }
    console.log(`Latency:         ${result.meta.latency_ms}ms`);
    if (result.summary) {
      console.log(`\n=== EXECUTIVE SUMMARY ===`);
      console.log(result.summary.formatted + "\n");
    }
  }

  if (!result.passed) {
    process.exit(1);
  }
}

// pathToFileURL, not a hand-built `file://` string: on Windows the URL is file:///D:/...
// and the hand-built form never matched, so the CLI silently did nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error("Receipt gate execution failed:", err.message);
    process.exit(1);
  });
}
