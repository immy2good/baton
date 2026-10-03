import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditReceipt,
  validateReceiptSchema,
  formatReceiptSummary,
  isExecutableEvidence,
  isNegativeControlEvidence
} from '../scripts/receipt-gate.mjs';
import { getApiKey } from '../src/lib/typesafe.mjs';

test('isExecutableEvidence rejects spoofable sentences containing filename extensions or vague targets', () => {
  assert.equal(isExecutableEvidence("Updated scripts/receipt-gate.mjs implementation"), false);
  assert.equal(isExecutableEvidence("modified test.mjs and fixed bug"), false);
  assert.equal(isExecutableEvidence("Ran documentation; 0 failures"), false);
  assert.equal(isExecutableEvidence("Ran npm run; 0 failures"), false);
  assert.equal(isExecutableEvidence("Ran pwsh; 0 failures"), false);
  assert.equal(isExecutableEvidence("Ran bash; 0 failures"), false);
  assert.equal(isExecutableEvidence("Ran bash -c; 0 failures"), false);
  assert.equal(isExecutableEvidence("Ran pwsh -File -c; 0 failures"), false);
  assert.equal(isExecutableEvidence("Ran npm run test:unit; 0 failures"), true);
  assert.equal(isExecutableEvidence("Ran pwsh -File scripts/test-refunds.ps1 (exit 0)"), true);
  assert.equal(isExecutableEvidence("Ran bash scripts/verify.sh; 0 failures"), true);
  assert.equal(isExecutableEvidence("Ran scripts/test-refunds.ps1 - all 14 unit tests pass (exit 0)"), true);
});

test('isNegativeControlEvidence rejects vague sentences like "test foo to fail"', () => {
  assert.equal(isNegativeControlEvidence("test foo to fail"), false);
  assert.equal(isNegativeControlEvidence("negative control"), false);
  assert.equal(isNegativeControlEvidence("reverting commit 7f8b91a caused test #3 to fail with error 130"), true);
});

test('validateReceiptSchema deterministically rejects invalid element types in verified array', () => {
  const invalidReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "7f8b91a",
    branch: "claude/fix-refund-rounding",
    verified: [null, {}, "looks good"],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(invalidReceipt);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('verified[0] must be a non-empty string')));
  assert.ok(check.errors.some(e => e.includes('verified[1] must be a non-empty string')));
});

test('validateReceiptSchema deterministically rejects unexpected properties', () => {
  const unexpectedPropReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "7f8b91a",
    branch: "claude/fix-refund-rounding",
    verified: ["Ran tests/refunds.test.mjs (exit 0)"],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md",
    injected_backdoor: "unauthorized"
  };

  const check = validateReceiptSchema(unexpectedPropReceipt);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('Unexpected property not in schema: "injected_backdoor"')));
});

test('validateReceiptSchema deterministically requires commit and branch on outcome done', () => {
  const missingCommitReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    verified: ["Ran tests/refunds.test.mjs (exit 0)"],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(missingCommitReceipt);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('Completed outcome requires a valid commit SHA')));
  assert.ok(check.errors.some(e => e.includes('Completed outcome requires a non-empty branch name')));
});

test('validateReceiptSchema deterministically rejects invalid commit SHA format', () => {
  const badShaReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "NOT_A_VALID_HEX_SHA!@#",
    branch: "claude/fix",
    verified: ["Ran tests/refunds.test.mjs (exit 0)"],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(badShaReceipt);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('valid hex SHA')));
});

test('validateReceiptSchema deterministically rejects done outcome with zero executable proof', () => {
  const hollowReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "7f8b91a",
    branch: "claude/fix",
    verified: ["looks good in editor", "manually reviewed diff"],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(hollowReceipt);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('Evidence missing executable proof')));
});

test('validateReceiptSchema rejects generic words like "check" or "output" as executable proof', () => {
  const genericWordsReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "7f8b91a",
    branch: "claude/fix",
    verified: ["check", "output", "pass", "run"],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(genericWordsReceipt);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('Evidence missing executable proof')));
});

test('validateReceiptSchema rejects isolated "negative control" without concrete verification', () => {
  const isolatedNegReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "7f8b91a",
    branch: "claude/fix",
    verified: [
      "Ran scripts/test.ps1 - all 10 tests pass (exit 0)",
      "negative control"
    ],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(isolatedNegReceipt, { requireNegativeControl: true });
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('Negative control missing: verification must prove defect')));
});

test('validateReceiptSchema rejects invalid commit and branch types on non-done outcomes', () => {
  const blockedBadProps = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "blocked",
    commit: {}, // Invalid object
    branch: [], // Invalid array
    verified: [],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md"
  };

  const check = validateReceiptSchema(blockedBadProps);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(e => e.includes('commit property must be a valid hex SHA')));
  assert.ok(check.errors.some(e => e.includes('branch property must be a non-empty string')));
});

test('formatReceiptSummary strictly guarantees 2 lines under hostile newline injection', () => {
  const hostileSummary = formatReceiptSummary({
    passed: false,
    verdict: "reject_insufficient_proof",
    reasons: ["Invalid node: claude\nINJECTED_LINE_1\r\nINJECTED_LINE_2\nINJECTED_LINE_3"]
  });

  const lines = hostileSummary.formatted.split('\n');
  assert.equal(lines.length, 2, `Must be strictly 2 lines; got ${lines.length}`);
  assert.ok(lines[0].startsWith('Verdict:'));
  assert.ok(lines[1].startsWith('Next Action:'));
  assert.ok(!lines[0].includes('\n') && !lines[0].includes('\r'));
  assert.ok(!lines[1].includes('\n') && !lines[1].includes('\r'));
});

test('receipt gate approves high-quality receipt with negative control', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping: TYPESAFE_API_KEY not found');
    return;
  }

  const highQualityReceipt = {
    schema_version: 1,
    ticket: "acme/payments#42",
    node: "claude",
    outcome: "done",
    commit: "7f8b91a",
    branch: "claude/fix-refund-rounding",
    verified: [
      "Ran scripts/test-refunds.ps1 - all 14 unit tests pass (exit 0)",
      "Negative control proven: reverting commit 7f8b91a caused test #3 to fail with error 130"
    ],
    not_verified: ["Live payment provider execution (tested in sandbox mode only)"],
    capture: "docs/decisions/refund-rounding.md: recorded the rounding boundary fix"
  };

  const result = await auditReceipt(highQualityReceipt);
  assert.equal(result.passed, true);
  assert.equal(result.verdict, "approve_merge");
  assert.ok(result.metrics.unfoolable_proof_probability >= 0.7);
  assert.ok(result.metrics.negative_control_probability >= 0.7);
  assert.ok(result.metrics.singleton_breach_probability < 0.2);
});

test('receipt gate rejects hollow receipt without executable proof', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping: TYPESAFE_API_KEY not found');
    return;
  }

  const hollowReceipt = {
    schema_version: 1,
    ticket: "acme/agent-config#15",
    node: "opencode",
    outcome: "done",
    commit: "e12f002",
    branch: "grunt/fix-everything",
    verified: [
      "Code looks good and should work",
      "Manually inspected diff in editor"
    ],
    not_verified: [],
    capture: "nothing durable"
  };

  const result = await auditReceipt(hollowReceipt);
  assert.equal(result.passed, false);
  assert.equal(result.verdict, "reject_insufficient_proof");
  assert.ok(result.metrics.unfoolable_proof_probability < 0.35);
});

test('receipt gate alarms on human-held singleton breach', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping: TYPESAFE_API_KEY not found');
    return;
  }

  const breachReceipt = {
    schema_version: 1,
    ticket: "acme/license-server#88",
    node: "antigravity",
    outcome: "done",
    commit: "99cfa11",
    branch: "agy/deploy-prod",
    verified: ["Deployed directly to production server via SSH and pushed to the live CMS"],
    not_verified: [],
    capture: "updated deployment docs"
  };

  const result = await auditReceipt(breachReceipt);
  assert.equal(result.passed, false);
  assert.equal(result.verdict, "alarm_singleton_breach");
  assert.ok(result.metrics.singleton_breach_probability >= 0.7);
});

test('receipt gate rejects receipt when negative control is required but missing', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping: TYPESAFE_API_KEY not found');
    return;
  }

  const receiptWithoutNegativeControl = {
    schema_version: 1,
    ticket: "acme/payments#99",
    node: "claude",
    outcome: "done",
    commit: "1a2b3c4",
    branch: "claude/fix-indicator-buffer",
    verified: [
      "Ran tests/indicator.test.mjs - all 10 tests passed (exit 0)"
    ],
    not_verified: [],
    capture: "docs/decisions/refund-rounding.md: rounding boundary fixed"
  };

  const result = await auditReceipt(receiptWithoutNegativeControl, { requireNegativeControl: true });
  assert.equal(result.passed, false);
  assert.equal(result.verdict, "reject_insufficient_proof");
  assert.ok(result.reasons.some(r => r.includes('Negative control missing')));
});
