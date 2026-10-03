import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { auditReceipt, validateReceiptSchema } from '../scripts/receipt-gate.mjs';
import { auditContractDrift } from '../src/lib/contract-lint.mjs';
import { getApiKey } from '../src/lib/typesafe.mjs';

const CANARY_PATH = new URL('./canary-suite.json', import.meta.url);
const canaryData = JSON.parse(readFileSync(CANARY_PATH, 'utf8'));

test('canary suite structure is strictly valid', () => {
  assert.equal(canaryData.version, '1.0.0');
  assert.equal(canaryData.model_target, 'jev-1.13.0');
  assert.ok(Array.isArray(canaryData.canaries));
  assert.ok(canaryData.canaries.length >= 5);

  for (const canary of canaryData.canaries) {
    assert.ok(canary.id, `Canary missing id: ${JSON.stringify(canary)}`);
    assert.ok(['receipt', 'contract_drift'].includes(canary.type), `Unknown type: ${canary.type}`);
    assert.ok(canary.description, `Canary missing description`);
    assert.ok(canary.recorded_response, `Canary ${canary.id} missing recorded_response`);
  }
});

test('receipt canaries validate according to their evidential quality', () => {
  const highQuality = canaryData.canaries.find(c => c.id === 'canary_receipt_high_quality');
  const checkHigh = validateReceiptSchema(highQuality.payload);
  assert.equal(checkHigh.valid, true, `High quality canary must be structurally valid: ${checkHigh.errors.join(', ')}`);

  const hollow = canaryData.canaries.find(c => c.id === 'canary_receipt_hollow');
  const checkHollow = validateReceiptSchema(hollow.payload);
  assert.equal(checkHollow.valid, false, 'Hollow receipt must be deterministically caught by schema proof validation');
  assert.ok(checkHollow.errors.some(e => e.includes('Evidence missing executable proof')));
});

test('canary suite evaluates deterministically via recorded frozen benchmark responses (mandatory offline gate)', async () => {
  let passedCanaries = 0;
  const total = canaryData.canaries.length;

  for (const canary of canaryData.canaries) {
    // Inject recorded response via mock transport to execute full pipeline offline
    const queryJevFn = async () => canary.recorded_response;

    if (canary.type === 'receipt') {
      const result = await auditReceipt(canary.payload, { queryJevFn });
      assert.equal(
        result.verdict,
        canary.expected_verdict,
        `Offline canary ${canary.id} expected "${canary.expected_verdict}", got "${result.verdict}"`
      );
      passedCanaries++;
    } else if (canary.type === 'contract_drift') {
      const result = await auditContractDrift(canary.payload, { queryJevFn });
      assert.equal(
        result.category,
        canary.expected_category,
        `Offline canary ${canary.id} expected category "${canary.expected_category}", got "${result.category}"`
      );
      passedCanaries++;
    }
  }

  assert.equal(passedCanaries, total, `All ${total} canaries must pass offline deterministic verification`);
});

test('canary suite evaluates against live Jev model jev-1.13.0 (model promotion gate)', async (t) => {
  const apiKey = getApiKey();
  const isPromotionGate = process.env.CI_MODEL_PROMOTION === '1';

  if (!apiKey) {
    if (isPromotionGate) {
      assert.fail('Model promotion gate failed: TYPESAFE_API_KEY required for promotion verification');
    }
    t.skip('Skipping live canary evaluation: TYPESAFE_API_KEY not found');
    return;
  }

  let passedCanaries = 0;
  const total = canaryData.canaries.length;
  const auditReport = [];

  for (const canary of canaryData.canaries) {
    if (canary.type === 'receipt') {
      const result = await auditReceipt(canary.payload);
      assert.equal(
        result.verdict,
        canary.expected_verdict,
        `Canary ${canary.id} expected verdict "${canary.expected_verdict}", got "${result.verdict}"`
      );
      auditReport.push({ id: canary.id, verdict: result.verdict, status: 'pass', latency: result.meta?.latency_ms });
      passedCanaries++;
    } else if (canary.type === 'contract_drift') {
      const result = await auditContractDrift(canary.payload);
      assert.equal(
        result.category,
        canary.expected_category,
        `Canary ${canary.id} expected category "${canary.expected_category}", got "${result.category}"`
      );
      auditReport.push({ id: canary.id, category: result.category, status: 'pass', latency: result.meta?.latency_ms });
      passedCanaries++;
    }
  }

  assert.equal(passedCanaries, total, `All ${total} canaries must pass against live jev-1.13.0`);
});
