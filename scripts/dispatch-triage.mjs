#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { choice, score, noul, queryJev } from '../src/lib/typesafe.mjs';
import { apexReviewDecision } from '../src/lib/review-policy.mjs';
import { escalationDecision, formatEscalation, APEX_NOUL_THRESHOLD } from '../src/lib/triage-gate.mjs';
import { countActiveNodes } from '../src/lib/capacity.mjs';
import { loadRoster, resolveDispatch, formatReviewDiamond } from '../src/lib/roster.mjs';
import { formatTwoLineSummary } from '../src/lib/preflight.mjs';
import { identifyTouchedContracts } from '../src/lib/contract-lint.mjs';

/**
 * CLI tool for evaluating an incoming issue and naming the writer and reviewers.
 *
 * Jev classifies (domain, work type, risk, apex). It does NOT pick the worker:
 * src/lib/roster.mjs resolves the pairing deterministically from the profiles
 * plus roster/routing.json, so the option list can never make the decision.
 */
async function main() {
  const options = {
    title: { type: 'string', short: 't' },
    desc: { type: 'string', short: 'd' },
    issue: { type: 'string', short: 'i' },
    author: { type: 'string', short: 'a' },
    'active-nodes': { type: 'string' },
    json: { type: 'boolean', short: 'j', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  };

  const { values, positionals } = parseArgs({
    options,
    allowPositionals: true,
    strict: false
  });

  if (values.help || (!values.title && positionals.length === 0)) {
    console.log(`
Usage:
  node scripts/dispatch-triage.mjs --title "<title>" [--desc "<description>"] [--json]
  node scripts/dispatch-triage.mjs "Fix rounding in the refund calculation"

Options:
  -t, --title    Issue title or summary
  -d, --desc     Detailed description or acceptance criteria
  -i, --issue    GitHub issue identifier (e.g. #42)
  -a, --author   Model id that wrote (or will write) the change, e.g. claude-fable-5-1.
                 A T0 author waives apex review (frontier does not review frontier).
                 Omit it and the resolved writer is treated as the author.
      --active-nodes  How many agents are already working. Omitted, it is counted
                      live from the launcher. At or over routing.max_active_nodes the
                      result is flagged at_capacity -- a queue signal, not a block.
  -j, --json     Output pure JSON for programmatic use
  -h, --help     Show this help message
`);
    process.exit(0);
  }

  const title = values.title || positionals[0] || '';
  const desc = values.desc || (positionals.slice(1).join(' ')) || '';
  const state = `Issue: ${title}\nDetails: ${desc}`;

  const questions = {
    domain: choice("What domain does this task belong to?", {
      critical_systems: "Payments, money movement, order execution, or any code where a bug costs real money",
      auth_security: "Authentication, licensing, permissions, tokens, webhooks",
      web_ui: "Web front-ends, themes, landing pages, CSS layout, copy",
      infrastructure: "Agent tooling, launcher configs, schemas, CI/CD, scripts"
    }),
    work_type: choice("What kind of work is this?", {
      implement: "Write or change behaviour, with tests -- the normal scoped ticket",
      docs: "Documentation, decision record, runbook, handoff or resume note; no behaviour change",
      research: "Answer a question from primary sources; produces a cited brief, not code",
      bulk: "Mechanical churn: renames, formatting, log triage, release notes, summaries"
    }),
    risk_score: score("Rate the operational and financial risk of modifying this code", [
      "Negligible risk (docs, comments, mechanical test rename)",
      "Low to medium risk (isolated UI styling, non-critical helper)",
      "High risk (shared contracts, auth or licensing logic, installer packaging)",
      "Critical risk (money movement, production data, secrets)"
    ]),
    requires_apex_review: noul(
      "Does this task modify money movement, auth, licensing, or security-sensitive code requiring apex reviewer sign-off?"
    )
  };

  const { answers, latencyMs, usage } = await queryJev(state, questions);

  const riskScore = answers.risk_score.score;

  // The gate runs BEFORE the resolver on purpose. Once a writer and reviewer are
  // named, a downstream caller will use them -- so an escalated triage must never
  // produce a pairing at all, only the answers and the probabilities that split.
  const escalation = escalationDecision({ answers });
  if (escalation.escalate) {
    const escalated = {
      issue: values.issue || 'ad-hoc',
      title,
      escalate: true,
      escalation_reasons: escalation.reasons,
      probabilities: escalation.probabilities,
      confidences: escalation.confidences,
      domain: answers.domain.choice,
      work_type: answers.work_type.choice,
      risk_score: riskScore,
      touched_contracts: identifyTouchedContracts(`${title} ${desc}`),
      writer: null,
      reviewer: null,
      meta: { latency_ms: latencyMs, tokens_in: usage.input_tokens, tokens_out: usage.output_tokens }
    };
    if (values.json) {
      console.log(JSON.stringify(escalated, null, 2));
    } else {
      console.log(`\nTitle: ${title}`);
      console.log(formatEscalation(escalation) + '\n');
    }
    return;
  }

  const apex = apexReviewDecision({
    apexProbability: answers.requires_apex_review.noul,
    threshold: APEX_NOUL_THRESHOLD,
    author: values.author
  });

  const roster = loadRoster();
  // Counted live unless the caller passed it. countActiveNodes() returns null when
  // The launcher is unreadable -- 0 would claim nothing is running when we simply cannot see it.
  const declared = values['active-nodes'] !== undefined ? Number(values['active-nodes']) : null;
  const activeNodes = Number.isFinite(declared) ? declared : countActiveNodes();

  const dispatch = resolveDispatch({
    domain: answers.domain.choice,
    workType: answers.work_type.choice,
    riskScore,
    requiresApex: apex.required,
    apexWaived: apex.waived,
    author: values.author,
    roster,
    activeNodes: activeNodes ?? 0
  });

  const touchedContracts = identifyTouchedContracts(`${title} ${desc}`);

  const result = {
    issue: values.issue || "ad-hoc",
    title,
    domain: answers.domain.choice,
    domain_confidence: answers.domain.confidence,
    work_type: answers.work_type.choice,
    work_type_confidence: answers.work_type.confidence,
    risk_score: riskScore,
    requires_apex_review: dispatch.requires_apex_review,
    apex_probability: answers.requires_apex_review.noul,
    apex_waived: dispatch.apex_waived,
    apex_waived_reason: apex.reason || dispatch.apex_waived_reason,
    author: values.author || null,
    effective_author: dispatch.effective_author,
    escalate: false,
    writer_fallback_from: dispatch.writer_fallback_from,
    failsafe_used: dispatch.failsafe_used,
    failsafe_forced: dispatch.failsafe_forced,
    failsafe_reason: dispatch.failsafe_reason,
    at_capacity: dispatch.at_capacity,
    max_active_nodes: dispatch.max_active_nodes,
    touched_contracts: touchedContracts,
    // The runtime binding travels WITH the decision. Without it, a dispatch runs at
    // whatever effort the launcher defaults to, because nothing downstream carries one.
    review_diamond: formatReviewDiamond(dispatch),
    meta: {
      roster_source: dispatch.roster_source,
      latency_ms: latencyMs,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens
    }
  };

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const bind = b => `${b.provider}/${b.model}${b.thinkingOptionId ? ` @${b.thinkingOptionId}` : ''}`;
    console.log(`\n=== JEV DISPATCH & REVIEW DIAMOND TRIAGE ===`);
    console.log(`Title:               ${title}`);
    console.log(`Domain:              ${result.domain} (confidence: ${result.domain_confidence})`);
    console.log(`Work Type:           ${result.work_type}`);
    console.log(`Risk Score:          ${result.risk_score} / 3.0`);
    if (touchedContracts.length > 0) {
      console.log(`Touched Contracts:   ${touchedContracts.map(c => c.name).join(', ')}`);
    }
    console.log(`Assigned Writer:     ${dispatch.writer.name} [${dispatch.writer.tier}]`);
    if (dispatch.writer_fallback_from) {
      console.log(`  pool fallback:     ${dispatch.failsafe_reason}`);
    }
    if (dispatch.failsafe_forced) {
      console.log(`  !! FORCED:         every pool in the chain is dead; dispatched anyway rather than blocking`);
    }
    console.log(`  runtime binding:   ${bind(dispatch.writer.binding)} (mode ${dispatch.writer.binding.modeId})`);
    console.log(`Reviewer:            ${dispatch.reviewer.name} -- ${dispatch.reviewer_reason}`);
    console.log(`  runtime binding:   ${bind(dispatch.reviewer.binding)}`);
    if (dispatch.cross_model_reviewer) {
      console.log(`Cross-model voice:   ${dispatch.cross_model_reviewer.name}`);
    }
    console.log(`Apex Review Needed:  ${result.requires_apex_review ? "YES" : (result.apex_waived ? `WAIVED - ${result.apex_waived_reason}` : "NO")}`);
    console.log(`Family Split Valid:  ${result.review_diamond.family_split_valid}`);
    console.log(`Roster Source:       ${result.meta.roster_source}`);
    console.log(`Active Nodes:        ${activeNodes ?? 'unknown (launcher unreadable)'} / ${dispatch.max_active_nodes}${dispatch.at_capacity ? '  -- AT CAPACITY, queue this' : ''}`);
    console.log(`Evaluation Latency:  ${latencyMs}ms (${usage.input_tokens} tokens in, ${usage.output_tokens} tokens out)`);

    const briefSummary = formatTwoLineSummary({
      riskScore,
      domain: answers.domain.choice,
      workKind: answers.work_type.choice,
      flags: {
        touches_critical_path: answers.requires_apex_review.noul >= 0.5 && answers.domain.choice === 'critical_systems',
        touches_cross_repo_contract: riskScore >= 2,
        requires_human_approval: riskScore >= 3,
        // `bugfix` was tested here and is not one of the four work_type ids
        // (implement | docs | research | bulk) -- a dead branch since the option
        // list was written.
        requires_negative_control: answers.work_type.choice === 'implement'
      },
      probabilities: {
        critical_path: answers.requires_apex_review.noul
      },
      confidence: answers.domain.confidence
    });

    console.log(`\n=== EXECUTIVE SUMMARY ===`);
    console.log(briefSummary.formatted + "\n");
  }
}

main().catch(err => {
  console.error("Dispatch triage error:", err.message);
  process.exit(1);
});
