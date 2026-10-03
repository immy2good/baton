import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE_FLOOR,
  APEX_NOUL_THRESHOLD,
  escalationDecision
} from '../src/lib/triage-gate.mjs';

/**
 * Issue #11: a confidence was recorded on every classification and never thresholded.
 *
 * The live case that made this gate necessary: `risk_score` came back 2.43 with
 * confidence 0.54 and probabilities {2: 0.55, 3: 0.44} -- Jev split between High and
 * Critical. We took 2.43 and routed. The intent-routing pattern says that is exactly
 * the case that goes to a human.
 */

const confident = (choice, confidence = 0.9) => ({
  choice,
  confidence,
  probabilities: { [choice]: confidence }
});

const decisive = {
  domain: confident('infrastructure'),
  work_type: confident('implement'),
  risk_score: { score: 1.05, confidence: 0.88, probabilities: { 0: 0.05, 1: 0.88, 2: 0.07 } }
};

test('a decisive classification is NOT escalated', () => {
  const d = escalationDecision({ answers: decisive });
  assert.equal(d.escalate, false, 'a gate that escalates everything is not a gate');
  assert.deepEqual(d.reasons, []);
});

test('confidence below the floor on work_type escalates', () => {
  const d = escalationDecision({
    answers: {
      ...decisive,
      work_type: { choice: 'implement', confidence: 0.41, probabilities: { implement: 0.41, bulk: 0.39 } }
    }
  });
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('low_confidence:work_type'), d.reasons.join(','));
});

test('confidence below the floor on domain escalates -- domain drives routing too', () => {
  const d = escalationDecision({
    answers: { ...decisive, domain: { choice: 'web_ui', confidence: 0.33, probabilities: { web_ui: 0.33, auth_security: 0.32 } } }
  });
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('low_confidence:domain'), d.reasons.join(','));
});

test('confidence exactly at the floor is accepted -- the rule is < 0.5, not <= 0.5', () => {
  const d = escalationDecision({
    answers: { ...decisive, work_type: confident('implement', CONFIDENCE_FLOOR) }
  });
  assert.equal(d.escalate, false);
});

test('the live 2.43 / 0.54 answer straddles the risk>=3 boundary and escalates', () => {
  const d = escalationDecision({
    answers: {
      ...decisive,
      risk_score: { score: 2.43, confidence: 0.54, probabilities: { 2: 0.55, 3: 0.44 } }
    }
  });
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('straddle:risk_score@3'), d.reasons.join(','));
  assert.deepEqual(d.probabilities.risk_score, { 2: 0.55, 3: 0.44 },
    'the human must SEE the split, not a rounded 2.43');
});

test('a split across the risk>=2 boundary escalates too -- both boundaries are live', () => {
  const d = escalationDecision({
    answers: {
      ...decisive,
      risk_score: { score: 1.52, confidence: 0.49, probabilities: { 1: 0.48, 2: 0.47, 0: 0.05 } }
    }
  });
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('straddle:risk_score@2'), d.reasons.join(','));
});

test('a top-2 split INSIDE one band does not escalate -- 0 and 1 cross no boundary', () => {
  const d = escalationDecision({
    answers: {
      ...decisive,
      risk_score: { score: 0.51, confidence: 0.52, probabilities: { 0: 0.49, 1: 0.48, 2: 0.03 } }
    }
  });
  assert.equal(d.escalate, false, 'only the routing boundaries 2 and 3 matter');
});

test('every reason is a machine-branchable string, never prose', () => {
  const d = escalationDecision({
    answers: {
      domain: { choice: 'web_ui', confidence: 0.2, probabilities: { web_ui: 0.2 } },
      work_type: { choice: 'bulk', confidence: 0.2, probabilities: { bulk: 0.2 } },
      risk_score: { score: 2.5, confidence: 0.3, probabilities: { 2: 0.5, 3: 0.5 } }
    }
  });
  assert.equal(d.reasons.length, 3);
  for (const r of d.reasons) {
    assert.match(r, /^[a-z_]+:[a-z_]+(@\d+)?$/, `reason "${r}" is not machine-branchable`);
  }
});

test('the apex noul cut-off is ONE named constant, not 0.65 here and 0.50 there', () => {
  assert.equal(typeof APEX_NOUL_THRESHOLD, 'number');
  assert.ok(APEX_NOUL_THRESHOLD > 0 && APEX_NOUL_THRESHOLD < 1);
});

test('a missing or malformed answer escalates rather than routing on a default', () => {
  const d = escalationDecision({ answers: { ...decisive, work_type: { choice: 'implement' } } });
  assert.equal(d.escalate, true);
  assert.ok(d.reasons.includes('low_confidence:work_type'),
    'an absent confidence must not read as a confident answer');
});
