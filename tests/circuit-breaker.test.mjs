import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskCircuitBreaker, DEFAULT_MAX_TURNS, DEFAULT_MAX_CONSECUTIVE_FAILURES } from '../src/lib/circuit-breaker.mjs';

test('TaskCircuitBreaker defaults to 15 turns and 3 consecutive failures', () => {
  const breaker = new TaskCircuitBreaker();
  assert.equal(breaker.maxTurns, 15);
  assert.equal(breaker.maxConsecutiveFailures, 3);
  assert.equal(breaker.state.tripped, false);
});

test('TaskCircuitBreaker trips when turn limit is reached', () => {
  const breaker = new TaskCircuitBreaker({ maxTurns: 5 });

  for (let i = 1; i <= 4; i++) {
    const status = breaker.recordTurn();
    assert.equal(status.tripped, false);
    assert.equal(status.turns, i);
  }

  // 5th turn triggers trip
  const status5 = breaker.recordTurn();
  assert.equal(status5.tripped, true);
  assert.ok(status5.reason.includes('turn_limit_exceeded'));
  assert.ok(status5.trippedAt);

  // Subsequent turns remain tripped
  const status6 = breaker.recordTurn();
  assert.equal(status6.tripped, true);
});

test('TaskCircuitBreaker trips on consecutive failures and recovers on success', () => {
  const breaker = new TaskCircuitBreaker({ maxConsecutiveFailures: 3 });

  // 2 failures
  breaker.recordOutcome(false, 'npm test');
  breaker.recordOutcome(false, 'npm test');
  assert.equal(breaker.state.consecutiveFailures, 2);
  assert.equal(breaker.state.tripped, false);

  // Success resets consecutive failures
  breaker.recordOutcome(true, 'npm test');
  assert.equal(breaker.state.consecutiveFailures, 0);
  assert.equal(breaker.state.tripped, false);

  // 3 consecutive failures trip
  breaker.recordOutcome(false, 'npm test');
  breaker.recordOutcome(false, 'npm test');
  breaker.recordOutcome(false, 'npm test');
  assert.equal(breaker.state.tripped, true);
  assert.ok(breaker.state.reason.includes('consecutive_failures_exceeded'));
});

test('TaskCircuitBreaker validates allowance rules under the tier policy', () => {
  const breaker = new TaskCircuitBreaker();

  // Metered OpenRouter attempted when subscription has capacity
  const check1 = breaker.validateAllowance({ hasSubscriptionCapacity: true }, 'openrouter/anthropic/claude-3.5-sonnet');
  assert.equal(check1.allowed, false);
  assert.equal(breaker.state.tripped, true);
  assert.ok(breaker.state.reason.includes('allowance_policy_breach'));

  // Reset and verify allowed subscription route
  breaker.reset();
  const check2 = breaker.validateAllowance({ hasSubscriptionCapacity: true }, 'opencode/local');
  assert.equal(check2.allowed, true);
  assert.equal(breaker.state.tripped, false);
});

test('TaskCircuitBreaker supports serialization to/from JSON', () => {
  const breaker = new TaskCircuitBreaker({ maxTurns: 10, harness: 'claude-code' });
  breaker.recordTurn();
  breaker.recordTurn();

  const serialized = breaker.toJSON();
  const restored = TaskCircuitBreaker.fromJSON(serialized);

  assert.equal(restored.maxTurns, 10);
  assert.equal(restored.harness, 'claude-code');
  assert.equal(restored.state.turns, 2);
  assert.equal(restored.state.tripped, false);
});
