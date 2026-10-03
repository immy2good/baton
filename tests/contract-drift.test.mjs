import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KNOWN_CONTRACTS,
  identifyTouchedContracts,
  formatContractDriftSummary,
  auditContractDrift
} from '../src/lib/contract-lint.mjs';
import { getApiKey } from '../src/lib/typesafe.mjs';

test('identifyTouchedContracts correctly identifies the desktop IPC protocol', () => {
  const result = identifyTouchedContracts(['src/bridge/ipc-client.mjs', 'docs/setup-line.md']);
  assert.ok(result.some(c => c.id === 'ipc_protocol'));
});

test('identifyTouchedContracts correctly identifies licensing', () => {
  const result = identifyTouchedContracts('Modified license activation_token check and PRO_PLAN product code');
  assert.ok(result.some(c => c.id === 'licensing_auth'));
});

test('identifyTouchedContracts correctly identifies shared schema contracts', () => {
  const result = identifyTouchedContracts('ALTER TABLE orders in migrations/0042_add_status.sql');
  assert.ok(result.some(c => c.id === 'shared_schema'));
});

test('identifyTouchedContracts returns empty array for internal bus scripts', () => {
  const result = identifyTouchedContracts('fix typo in README.md and updated test timeout');
  assert.equal(result.length, 0);
});

test('formatContractDriftSummary generates 2-line summary for breaking drift', () => {
  const summary = formatContractDriftSummary({
    driftDetected: true,
    isBreaking: true,
    category: 'breaking_drift',
    contract: 'Desktop IPC Protocol',
    confidence: 0.94
  });

  assert.equal(typeof summary.formatted, 'string');
  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Verdict: Breaking contract drift detected in Desktop IPC Protocol \(confidence: 0\.94\)\./);
  assert.match(lines[1], /^Next Action: Add backward compatibility adapter or create coordinated cross-repo ticket\./);
});

test('formatContractDriftSummary generates 2-line summary for additive change', () => {
  const summary = formatContractDriftSummary({
    driftDetected: true,
    isBreaking: false,
    category: 'backward_compatible',
    contract: 'Licensing & Auth API',
    confidence: 0.88
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Verdict: Non-breaking additive contract evolution in Licensing & Auth API/);
  assert.match(lines[1], /^Next Action: Verify consumer tolerance in sibling tests before merge\./);
});

test('formatContractDriftSummary generates 2-line summary for requires_contract_review', () => {
  const summary = formatContractDriftSummary({
    driftDetected: true,
    isBreaking: false,
    category: 'requires_contract_review',
    contract: 'Desktop IPC Protocol',
    siblings: ['plugin-host', 'desktop-app'],
    confidence: 0.91
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Verdict: Shared contract boundary touched in Desktop IPC Protocol/);
  assert.match(lines[1], /^Next Action: Run sibling contract verification \(plugin-host, desktop-app\) before merge\./);
});

test('formatContractDriftSummary strictly guarantees 2 lines under hostile newline injection', () => {
  const summary = formatContractDriftSummary({
    driftDetected: true,
    isBreaking: true,
    category: 'breaking_drift',
    contract: 'IPC\nINJECTED_LINE_1\r\nINJECTED_LINE_2',
    confidence: 0.95
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2, `Must be strictly 2 lines; got ${lines.length}`);
  assert.ok(lines[0].startsWith('Verdict:'));
  assert.ok(lines[1].startsWith('Next Action:'));
  assert.ok(!lines[0].includes('\n') && !lines[0].includes('\r'));
});

test('formatContractDriftSummary generates 2-line summary for safe change', () => {
  const summary = formatContractDriftSummary({
    driftDetected: false,
    isBreaking: false,
    category: 'no_drift',
    confidence: 0.98
  });

  const lines = summary.formatted.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Verdict: No cross-repo contract drift detected/);
  assert.match(lines[1], /^Next Action: Safe to proceed within repository worktree boundary\./);
});

test('auditContractDrift executes live audit and catches breaking bridge drift', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping live contract drift test: TYPESAFE_API_KEY not found');
    return;
  }

  const breakingDiff = `
diff --git a/src/bridge/ipc.h b/src/bridge/ipc.h
-#define IPC_CMD_TICKET_OPEN "CMD_OPEN"
+#define IPC_CMD_TICKET_OPEN "CMD_OPEN_V2"
-// Dropped legacy parameter format
-int send_ticket(int id, double price);
+int send_ticket(const char* uuid, int id, double price, int flags);
`;

  const result = await auditContractDrift(breakingDiff, {
    context: "Cross-repo plugin IPC bridge protocol update"
  });

  assert.equal(result.drift_detected, true);
  assert.equal(result.is_breaking, true);
  assert.equal(result.category, 'breaking_drift');
  assert.ok(result.metrics.is_breaking_prob >= 0.5);
  assert.ok(result.summary.formatted.includes("Breaking contract drift detected"));
});
