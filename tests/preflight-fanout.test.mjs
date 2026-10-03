import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchTriage } from '../scripts/swarm-map.mjs';
import { getApiKey } from '../src/lib/typesafe.mjs';

test('Phase 2: Speculative fan-out pre-flight evaluates all operational dimensions simultaneously', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping live TypeSafe test: TYPESAFE_API_KEY not found');
    return;
  }

  const result = await dispatchTriage(
    "Fix rounding bug in the payment refund calculation",
    "Requires sandbox payment verification and proving negative control failure first"
  );

  assert.ok(result.domain === 'critical_systems', 'Should classify as critical_systems');
  assert.ok(result.preflight, 'Should return preflight object');
  assert.equal(result.preflight.requires_negative_control, true, 'Defect fix should require negative control');
  assert.ok(result.preflight.negative_control_prob >= 0.5, 'Negative control probability should be >= 0.5');
  assert.ok(result.preflight.harness_fit, 'Should recommend a harness fit');
  assert.ok(result.meta.latency_ms > 0, 'Should measure latency');
});

test('Phase 2: Pre-flight identifies singleton and live deployment risks', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping live TypeSafe test: TYPESAFE_API_KEY not found');
    return;
  }

  const result = await dispatchTriage(
    "Deploy license database updates directly to production hosting and the live CMS",
    "Touching production servers and live member portal"
  );

  assert.ok(result.preflight, 'Should return preflight object');
  assert.equal(result.preflight.touches_singletons, true, 'Should flag touches_singletons as true');
  assert.ok(result.preflight.singleton_prob >= 0.6, 'Singleton probability should be high');
  assert.ok(result.risk_score >= 1.5, 'Risk score should be elevated');
});
