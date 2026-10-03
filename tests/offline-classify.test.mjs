import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOffline, classify, OFFLINE_MODEL, tokens } from '../src/lib/offline-classify.mjs';
import { choice, score, noul } from '../src/lib/typesafe.mjs';
import { escalationDecision } from '../src/lib/triage-gate.mjs';
import { auditReceipt } from '../scripts/receipt-gate.mjs';

// The same question shapes dispatch-triage.mjs asks.
const QUESTIONS = {
  domain: choice('What domain does this task belong to?', {
    critical_systems: 'Payments, money movement, order execution, or any code where a bug costs real money',
    auth_security: 'Authentication, licensing, permissions, tokens, webhooks',
    web_ui: 'Web front-ends, themes, landing pages, CSS layout, copy',
    infrastructure: 'Agent tooling, launcher configs, schemas, CI/CD, scripts'
  }),
  work_type: choice('What kind of work is this?', {
    implement: 'Write or change behaviour, with tests',
    docs: 'Documentation, decision record, runbook, handoff or resume note; no behaviour change',
    research: 'Answer a question from primary sources; produces a cited brief, not code',
    bulk: 'Mechanical churn: renames, formatting, log triage, release notes, summaries'
  }),
  risk_score: score('Rate the operational and financial risk of modifying this code', ['negligible', 'low', 'high', 'critical']),
  requires_apex_review: noul('Does this task modify money movement, auth, licensing, or security-sensitive code requiring apex reviewer sign-off?')
};

const ask = title => classifyOffline(`Task: ${title}`, QUESTIONS).answers;

test('a money bug is critical, high risk, and asks for apex review', () => {
  const a = ask('Fix rounding in the refund calculation');
  assert.equal(a.domain.choice, 'critical_systems');
  assert.equal(a.work_type.choice, 'implement');
  assert.equal(a.risk_score.score, 3);
  assert.ok(a.requires_apex_review.noul >= 0.5);
});

test('a README typo is low-risk docs work with no apex review', () => {
  const a = ask('Fix typo in README');
  assert.equal(a.work_type.choice, 'docs');
  assert.equal(a.risk_score.score, 0);
  assert.ok(a.requires_apex_review.noul < 0.5);
});

test('auth work lands in auth_security', () => {
  assert.equal(ask('Rotate the JWT signing secret for login sessions').domain.choice, 'auth_security');
});

test('investigation is research, renames are bulk', () => {
  assert.equal(ask('Investigate why the build is slow').work_type.choice, 'research');
  assert.equal(ask('Rename helper functions across the codebase').work_type.choice, 'bulk');
});

test('no signal means low confidence, so the gate escalates instead of guessing', () => {
  const a = ask('Do the thing we discussed');
  assert.ok(a.domain.confidence < 0.5);
  assert.equal(escalationDecision({ answers: a }).escalate, true);
});

test('answers carry the same fields the gate and router read', () => {
  const a = ask('Add a dark mode toggle to the settings page');
  for (const k of ['domain', 'work_type']) {
    assert.equal(typeof a[k].choice, 'string');
    assert.equal(typeof a[k].confidence, 'number');
    assert.equal(typeof a[k].probabilities, 'object');
  }
  assert.equal(typeof a.risk_score.score, 'number');
  assert.equal(typeof a.requires_apex_review.noul, 'number');
});

test('classify() uses the offline classifier when asked, with no network', async () => {
  const r = await classify('Task: Fix typo in README', QUESTIONS, { offline: true });
  assert.equal(r.model, OFFLINE_MODEL);
  assert.equal(r.usage.input_tokens, 0);
});

test('tokens() drops stop words and punctuation', () => {
  assert.deepEqual(tokens('Does this task touch the Login page?'), ['login', 'page']);
});

const RECEIPT = {
  schema_version: 1, ticket: 'acme/web-app#212', node: 'claude', outcome: 'done', commit: 'a1b2c3d',
  branch: 'agent/claude/fix-refund-rounding',
  verified: ['Ran npm test (exit 0): 212 passed', 'Reverted the fix: tests/refunds.test.mjs failed (exit 1); restored it: passed (exit 0)'],
  not_verified: ['Live payment provider (sandbox only)'],
  capture: 'docs/decisions/refund-rounding.md'
};

test('offline receipt gate approves a receipt with command evidence and a negative control', async () => {
  const r = await auditReceipt(RECEIPT, { offline: true });
  assert.equal(r.verdict, 'approve_merge');
  assert.equal(r.meta.model, OFFLINE_MODEL);
});

test('offline receipt gate does not read an agent/ branch plus "live" as a production breach', async () => {
  const r = await auditReceipt(RECEIPT, { offline: true });
  assert.ok(r.metrics.singleton_breach_probability < 0.7);
});
