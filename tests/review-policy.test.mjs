import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFrontierAuthor, apexReviewDecision } from '../src/lib/review-policy.mjs';

test('frontier authors are recognised across harness routes', () => {
  for (const a of ['claude-fable-5-1', 'claude/claude-fable-5-1', 'cursor/claude-fable-5-1', 'codex/gpt-6-astra', ' GPT-6-Astra ']) {
    assert.equal(isFrontierAuthor(a), true, a);
  }
});

test('below-T0 and unknown authors are not frontier', () => {
  // claude-fable-5 (no -1) is the previous release, not the apex.
  for (const a of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'opencode-go/deepseek-v4-pro', 'claude-fable-5', '', undefined, null, 42]) {
    assert.equal(isFrontierAuthor(a), false, String(a));
  }
});

test('risky work by a below-T0 author still requires apex review', () => {
  const d = apexReviewDecision({ apexProbability: 0.9, threshold: 0.65, author: 'codex/gpt-5.6-sol' });
  assert.deepEqual(d, { required: true, waived: false, reason: null });
});

test('risky work with no author stated requires apex review (fail closed)', () => {
  assert.equal(apexReviewDecision({ apexProbability: 0.9, threshold: 0.65 }).required, true);
});

test('risky work by a T0 author waives apex review and says why', () => {
  const d = apexReviewDecision({ apexProbability: 0.9, threshold: 0.65, author: 'claude/claude-fable-5-1' });
  assert.equal(d.required, false);
  assert.equal(d.waived, true);
  assert.match(d.reason, /frontier does not review frontier/);
});

test('non-risky work is never "waived" - there was nothing to waive', () => {
  const d = apexReviewDecision({ apexProbability: 0.1, threshold: 0.65, author: 'claude-fable-5-1' });
  assert.deepEqual(d, { required: false, waived: false, reason: null });
});

test('a missing probability is not risky (and not a crash)', () => {
  assert.equal(apexReviewDecision({ apexProbability: undefined, threshold: 0.5, author: 'x' }).required, false);
});
