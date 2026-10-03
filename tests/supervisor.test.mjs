import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditWorktreeLiveness, SupervisorStateTracker } from '../src/lib/supervisor.mjs';
import { getApiKey } from '../src/lib/typesafe.mjs';

test('auditWorktreeLiveness returns safe fallback for empty telemetry', async () => {
  const result = await auditWorktreeLiveness(null);
  assert.equal(result.is_deadlocked, false);
  assert.equal(result.bottleneck_cause, 'insufficient_evidence');
  assert.equal(result.recommended_triage, 'no_action');
  assert.equal(result.advisory_only, true);
});

test('auditWorktreeLiveness deterministically catches explicit PendingPermissions', async () => {
  const telemetry = {
    path: 'C:/Users/dev/worktrees/blocked-task',
    branch: 'feat/new-gate',
    ageHours: 1.5,
    agentStatus: 'waiting',
    agentMessage: 'Waiting on PendingPermissions for git add',
    dirtyCount: 2
  };

  const result = await auditWorktreeLiveness(telemetry);
  assert.equal(result.is_deadlocked, true);
  assert.equal(result.bottleneck_cause, 'permission_gate');
  assert.equal(result.recommended_triage, 'alert_permission_block');
  assert.ok(result.urgency >= 2.5);
  assert.ok(result.triage_hint.includes('pending permission'));
});

test('auditWorktreeLiveness diagnoses healthy active worktree', async (t) => {
  if (!getApiKey()) {
    t.skip('Skipping live TypeSafe test: TYPESAFE_API_KEY not found');
    return;
  }

  const telemetry = {
    path: 'D:/code/app/worktrees/active-task',
    branch: 'feat/test-suite',
    ageHours: 0.1,
    dirtyCount: 3,
    agentStatus: 'running',
    agentMessage: 'Compiling tests and executing negative controls',
    hasPr: false
  };

  const result = await auditWorktreeLiveness(telemetry);
  assert.equal(result.is_deadlocked, false);
  assert.ok(result.deadlock_probability < 0.35);
  assert.equal(result.recommended_triage, 'no_action');
  assert.ok(result.latency_ms > 0);
});

test('SupervisorStateTracker enforces debouncing and consecutive count before alerting', () => {
  const tracker = new SupervisorStateTracker({ minConsecutive: 2 });

  const parkedReport = {
    worktree: 'D:/code/worktrees/old-parked',
    is_deadlocked: true,
    deadlock_probability: 0.8,
    bottleneck_cause: 'abandoned_wip',
    recommended_triage: 'prompt_prune_review',
    urgency: 1.5
  };

  // First observation: should NOT alert yet
  const obs1 = tracker.record(parkedReport);
  assert.equal(obs1.shouldAlert, false, 'First observation should not alert');
  assert.equal(obs1.consecutiveCount, 1);

  // Second observation: should alert!
  const obs2 = tracker.record(parkedReport);
  assert.equal(obs2.shouldAlert, true, 'Second consecutive observation must alert');
  assert.equal(obs2.consecutiveCount, 2);

  // Healthy recovery clears state
  const healthyReport = {
    worktree: 'D:/code/worktrees/old-parked',
    is_deadlocked: false,
    bottleneck_cause: 'active_computation'
  };
  const obs3 = tracker.record(healthyReport);
  assert.equal(obs3.shouldAlert, false);
  assert.equal(obs3.consecutiveCount, 0);
  assert.equal(tracker.getTracked().length, 0);
});

test('SupervisorStateTracker immediately alerts on permission gates without delay', () => {
  const tracker = new SupervisorStateTracker({ minConsecutive: 2 });

  const permReport = {
    worktree: 'D:/code/worktrees/perm-block',
    is_deadlocked: true,
    bottleneck_cause: 'permission_gate',
    recommended_triage: 'alert_permission_block',
    urgency: 3.0
  };

  const obs = tracker.record(permReport);
  assert.equal(obs.shouldAlert, true, 'Permission blocks must alert immediately on first observation');
  assert.equal(obs.consecutiveCount, 1);
});

test('auditWorktreeLiveness deterministically catches tripped circuit breaker', async () => {
  const telemetry = {
    path: 'D:/code/app/worktrees/runaway-task',
    branch: 'feat/stuck-loop',
    ageHours: 0.5,
    dirtyCount: 1,
    agentStatus: 'running',
    circuitBreaker: {
      tripped: true,
      reason: 'turn_limit_exceeded: 15/15 turns',
      turns: 15,
      maxTurns: 15
    }
  };

  const result = await auditWorktreeLiveness(telemetry);
  assert.equal(result.is_deadlocked, true);
  assert.equal(result.bottleneck_cause, 'circuit_breaker_tripped');
  assert.equal(result.recommended_triage, 'pause_for_human_review');
  assert.ok(result.urgency >= 3.0);
  assert.ok(result.triage_hint.includes('turn_limit_exceeded'));
});

test('SupervisorStateTracker immediately alerts on circuit breaker trips without delay', () => {
  const tracker = new SupervisorStateTracker({ minConsecutive: 2 });

  const breakerReport = {
    worktree: 'D:/code/worktrees/breaker-trip',
    is_deadlocked: true,
    bottleneck_cause: 'circuit_breaker_tripped',
    recommended_triage: 'pause_for_human_review',
    urgency: 3.0
  };

  const obs = tracker.record(breakerReport);
  assert.equal(obs.shouldAlert, true, 'Circuit breaker trips must alert immediately on first observation');
  assert.equal(obs.consecutiveCount, 1);
});

