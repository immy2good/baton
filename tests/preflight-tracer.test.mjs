import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTwoLineSummary, evaluatePreflight, PREFLIGHT_QUESTIONS } from '../src/lib/preflight.mjs';
import { getApiKey } from '../src/lib/typesafe.mjs';

test('PREFLIGHT_QUESTIONS contains all atomic evaluation dimensions', () => {
  assert.ok(PREFLIGHT_QUESTIONS.domain);
  assert.ok(PREFLIGHT_QUESTIONS.work_kind);
  assert.ok(PREFLIGHT_QUESTIONS.risk_score);
  assert.ok(PREFLIGHT_QUESTIONS.touches_critical_path);
  assert.ok(PREFLIGHT_QUESTIONS.touches_cross_repo_contract);
  assert.ok(PREFLIGHT_QUESTIONS.requires_human_approval);
  assert.ok(PREFLIGHT_QUESTIONS.ac_missing);
  assert.ok(PREFLIGHT_QUESTIONS.requires_negative_control);
  assert.ok(PREFLIGHT_QUESTIONS.requires_live_environment);
});

test('formatTwoLineSummary generates exact 2-line operational verdict for singleton risk', () => {
  const summary = formatTwoLineSummary({
    riskScore: 3,
    domain: 'infrastructure',
    workKind: 'feature',
    flags: { requires_human_approval: true },
    probabilities: { human_approval: 0.95 },
    confidence: 0.92
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2, 'Must format as exactly 2 lines');
  assert.match(lines[0], /^Verdict: Critical Risk \(3\/3\)/);
  assert.match(lines[0], /Singleton \/ Production Hazard/);
  assert.match(lines[1], /^Next Action: Escalate to a human/);
});

test('formatTwoLineSummary generates exact 2-line verdict for missing AC', () => {
  const summary = formatTwoLineSummary({
    riskScore: 1,
    domain: 'web_ui',
    workKind: 'feature',
    flags: { ac_missing: true },
    probabilities: { ac_missing: 0.88 },
    confidence: 0.84
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2, 'Must format as exactly 2 lines');
  assert.match(lines[0], /Ambiguous Requirements \/ Missing AC/);
  assert.match(lines[1], /Clarify desired outcome and acceptance criteria/);
});

test('formatTwoLineSummary generates exact 2-line verdict for critical path and cross-repo contract', () => {
  const summary = formatTwoLineSummary({
    riskScore: 3,
    domain: 'critical_systems',
    workKind: 'bugfix',
    flags: { touches_critical_path: true, touches_cross_repo_contract: true },
    probabilities: { critical_path: 0.91, cross_repo_contract: 0.85 },
    confidence: 0.89
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Critical Path Risk/);
  assert.match(lines[1], /Inspect the critical path and its contracts/);
});

test('evaluatePreflight exercises disagreement detection across boundary deltas 0, 1, and 2', async () => {
  const createMockJev = (score) => async () => ({
    answers: {
      domain: { choice: 'critical_systems', confidence: 0.95 },
      work_kind: { choice: 'bugfix', confidence: 0.92 },
      risk_score: { score },
      touches_critical_path: { noul: 0.8 },
      touches_cross_repo_contract: { noul: 0.7 },
      requires_human_approval: { noul: 0.1 },
      ac_missing: { noul: 0.1 },
      requires_negative_control: { noul: 0.8 },
      requires_live_environment: { noul: 0.2 }
    },
    usage: { input_tokens: 100, output_tokens: 20 },
    model: 'jev-1.13.0'
  });

  // Delta 0: baseline 2 vs jev 2 -> no disagreement
  const resDelta0 = await evaluatePreflight(
    { title: 'TDD task', baseline_risk: 2 },
    { queryJevFn: createMockJev(2) }
  );
  assert.equal(resDelta0.disagreement, null, 'Delta 0 should produce null disagreement');

  // Delta 1: baseline 1 vs jev 2 -> medium severity disagreement
  const resDelta1 = await evaluatePreflight(
    { title: 'TDD task', baseline_risk: 1 },
    { queryJevFn: createMockJev(2) }
  );
  assert.ok(resDelta1.disagreement, 'Delta 1 should trigger disagreement');
  assert.equal(resDelta1.disagreement.delta, 1);
  assert.equal(resDelta1.disagreement.severity, 'medium');

  // Delta 2: baseline 1 vs jev 3 -> high severity disagreement
  const resDelta2 = await evaluatePreflight(
    { title: 'TDD task', baseline_risk: 1 },
    { queryJevFn: createMockJev(3) }
  );
  assert.ok(resDelta2.disagreement, 'Delta 2 should trigger disagreement');
  assert.equal(resDelta2.disagreement.delta, 2);
  assert.equal(resDelta2.disagreement.severity, 'high');
});

test('formatTwoLineSummary guarantees exactly two lines even under hostile multiline inputs', () => {
  const hostileSummary = formatTwoLineSummary({
    riskScore: 2,
    domain: "critical_systems\nINJECTED_LINE_1\r\nINJECTED_LINE_2",
    workKind: "bugfix\nMORE_INJECTION",
    flags: { requires_negative_control: true },
    probabilities: { negative_control: 0.9 },
    confidence: 0.85
  });

  const lines = hostileSummary.formatted.split('\n');
  assert.equal(lines.length, 2, `Must be exactly 2 lines despite newline injection; got ${lines.length}`);
  assert.ok(lines[0].startsWith('Verdict:'));
  assert.ok(lines[1].startsWith('Next Action:'));
  assert.ok(!lines[0].includes('\n') && !lines[0].includes('\r'));
  assert.ok(!lines[1].includes('\n') && !lines[1].includes('\r'));
});

test('evaluatePreflight executes live batched preflight and returns a summary', async (t) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    t.skip('Skipping live TypeSafe test: TYPESAFE_API_KEY not found');
    return;
  }

  const result = await evaluatePreflight({
    title: 'Fix rounding in the payment refund calculation',
    description: 'Refund rounding bug causing rejected payouts on multi-currency orders',
    repo: 'payments',
    baseline_risk: 1 // Baseline assumed low, Jev will score high
  });

  assert.equal(result.domain, 'critical_systems');
  assert.ok(result.risk_score >= 2, 'Risk score should be elevated for a refund calculation bug');
  assert.ok(result.flags.touches_critical_path, 'Must flag touches_critical_path');
  assert.ok(result.summary.verdict.startsWith('Verdict:'), 'Must produce formatted verdict');
  assert.ok(result.summary.next_action.startsWith('Next Action:'), 'Must produce formatted next action');
  assert.ok(result.disagreement, 'Must detect disagreement with low baseline_risk');
  assert.equal(result.disagreement.type, 'risk_disagreement');
  assert.ok(result.meta.latency_ms > 0, 'Must record latency');
  assert.ok(result.trace, 'Must generate DecisionTrace');
  assert.equal(result.trace.decision_type, 'intake_preflight');
});
