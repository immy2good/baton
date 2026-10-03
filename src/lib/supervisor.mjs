import { choice, score, noul, queryJev } from './typesafe.mjs';

/**
 * Advisory categories for worktree bottleneck diagnosis.
 */
export const BOTTLENECK_CAUSES = {
  active_computation: "Agent is actively generating, compiling, or executing tests",
  permission_gate: "Agent is blocked on sandboxed CLI/filesystem permission elevation (PendingPermissions)",
  circuit_breaker_tripped: "Agent has exceeded turn limits, consecutive failure limits, or allowance policies",
  waiting_for_review: "Work is committed and verified, awaiting reviewer inspection or merge",
  test_regression: "Code changes are actively failing tests or compile cycles",
  abandoned_wip: "No commits or agent activity for an extended period; potential stale WIP",
  insufficient_evidence: "Insufficient telemetry to determine a blocker with confidence"
};

export const RECOMMENDED_TRIAGE = {
  no_action: "Work is progressing normally or no intervention warranted",
  alert_permission_block: "Notify a human of a sandboxed permission block requiring elevation",
  pause_for_human_review: "Circuit breaker tripped; pause autonomous execution and prompt human operator",
  suggest_reviewer: "Suggest dispatching an independent reviewer agent to verify and merge",
  prompt_prune_review: "Prompt a human to inspect or prune a potentially abandoned worktree",
  investigate_test_failure: "Prompt agent or developer to inspect recent test failure logs"
};

/**
 * Evaluates worktree telemetry using Jev System One as an advisory reflex layer.
 * Note: Per Agent Bus architectural invariants, this output is STRICTLY ADVISORY.
 * Destructive mutations (pruning) and permission elevations must NEVER be triggered
 * autonomously by model output alone.
 * 
 * @param {object} telemetry - Telemetry snapshot for a single worktree
 * @param {string} telemetry.path - Worktree filesystem path
 * @param {string} [telemetry.branch] - Git branch
 * @param {number} [telemetry.ageHours] - Hours since last commit or creation
 * @param {number} [telemetry.dirtyCount] - Count of modified/untracked files
 * @param {string} [telemetry.agentStatus] - launcher agent status (e.g. 'running', 'idle', 'waiting', 'error')
 * @param {string} [telemetry.agentMessage] - Recent status message or pending permission indicator
 * @param {object} [telemetry.circuitBreaker] - Optional circuit breaker status
 * @param {boolean} [telemetry.hasPr] - Whether an open PR exists
 * @param {object} [options] - Evaluation options
 * @param {number} [options.timeoutMs] - Jev call timeout (default 4000ms)
 * @returns {Promise<object>} Diagnostic advisory report
 */
export async function auditWorktreeLiveness(telemetry, options = {}) {
  if (!telemetry || !telemetry.path) {
    return {
      worktree: telemetry?.path || 'unknown',
      is_deadlocked: false,
      deadlock_probability: 0,
      bottleneck_cause: 'insufficient_evidence',
      recommended_triage: 'no_action',
      urgency: 0,
      triage_hint: 'No telemetry provided',
      advisory_only: true,
      observed_at: new Date().toISOString()
    };
  }

  // Deterministic fast-paths:
  const isExplicitPermissionBlock = 
    telemetry.agentStatus === 'waiting' || 
    /pending\s*permission|permission\s*required/i.test(telemetry.agentMessage || '');

  const isCircuitBreakerTripped = Boolean(telemetry.circuitBreaker?.tripped);

  // Format telemetry for Jev
  const stateSummary = {
    worktree: telemetry.path,
    branch: telemetry.branch || 'unknown',
    age_hours: telemetry.ageHours ?? 0,
    dirty_files: telemetry.dirtyCount ?? 0,
    agent_status: telemetry.agentStatus || 'none',
    agent_message: (telemetry.agentMessage || '').slice(0, 300),
    circuit_breaker: telemetry.circuitBreaker ? {
      tripped: telemetry.circuitBreaker.tripped,
      reason: telemetry.circuitBreaker.reason,
      turns: telemetry.circuitBreaker.turns,
      max_turns: telemetry.circuitBreaker.maxTurns
    } : null,
    has_open_pr: Boolean(telemetry.hasPr)
  };

  const questions = {
    is_deadlocked: noul(
      "Is this worktree currently stalled or blocked without forward progress (e.g. waiting indefinitely, permissions blocked, or abandoned)?"
    ),
    bottleneck_cause: choice("What is the primary operational status or bottleneck?", BOTTLENECK_CAUSES),
    recommended_triage: choice("What advisory triage action is recommended for the human supervisor?", RECOMMENDED_TRIAGE),
    urgency: score("How urgent is this situation for human awareness?", [
      "0 - Normal / In progress",
      "1 - Low / Parked worktree",
      "2 - Medium / Handoff waiting",
      "3 - High / Active blockage requiring human action"
    ])
  };

  try {
    const { answers, latencyMs } = await queryJev(
      JSON.stringify(stateSummary, null, 2),
      questions,
      { timeoutMs: options.timeoutMs ?? 4000, maxStateLength: 8000 }
    );

    const deadlockProb = answers.is_deadlocked.noul;
    let cause = answers.bottleneck_cause.choice;
    let triage = answers.recommended_triage.choice;
    let urgencyScore = answers.urgency.score;

    if (isExplicitPermissionBlock) {
      cause = 'permission_gate';
      triage = 'alert_permission_block';
      urgencyScore = Math.max(urgencyScore, 2.5);
    } else if (isCircuitBreakerTripped) {
      cause = 'circuit_breaker_tripped';
      triage = 'pause_for_human_review';
      urgencyScore = Math.max(urgencyScore, 3.0);
    }

    let triageHint = 'Normal operation.';
    if (cause === 'permission_gate') {
      triageHint = `Agent blocked on sandboxed permissions. Approve the pending permission in the agent's harness.`;
    } else if (cause === 'circuit_breaker_tripped') {
      triageHint = `Circuit breaker tripped: ${telemetry.circuitBreaker?.reason || 'turn/failure limit reached'}. Human review required.`;
    } else if (cause === 'waiting_for_review') {
      triageHint = `Work appears complete. Consider dispatching a reviewer agent.`;
    } else if (cause === 'abandoned_wip') {
      triageHint = `Worktree has been idle for ${telemetry.ageHours ?? '?'}h with no agent active.`;
    }

    return {
      worktree: telemetry.path,
      branch: telemetry.branch || 'unknown',
      is_deadlocked: deadlockProb >= 0.65 || isExplicitPermissionBlock || isCircuitBreakerTripped,
      deadlock_probability: (isExplicitPermissionBlock || isCircuitBreakerTripped) ? 1.0 : deadlockProb,
      bottleneck_cause: cause,
      recommended_triage: triage,
      urgency: Math.round(urgencyScore * 10) / 10,
      triage_hint: triageHint,
      advisory_only: true,
      latency_ms: latencyMs,
      observed_at: new Date().toISOString()
    };
  } catch (err) {
    // Fail safe to deterministic fallback on Jev error or timeout
    const cause = isExplicitPermissionBlock 
      ? 'permission_gate' 
      : (isCircuitBreakerTripped ? 'circuit_breaker_tripped' : 'insufficient_evidence');
    const triage = isExplicitPermissionBlock 
      ? 'alert_permission_block' 
      : (isCircuitBreakerTripped ? 'pause_for_human_review' : 'no_action');
    const isDeadlocked = isExplicitPermissionBlock || isCircuitBreakerTripped;

    let fallbackHint = `Jev evaluation unavailable: ${err.message}`;
    if (isExplicitPermissionBlock) {
      fallbackHint = `Agent blocked on sandboxed permissions. Approve the pending permission in the agent's harness.`;
    } else if (isCircuitBreakerTripped) {
      fallbackHint = `Circuit breaker tripped: ${telemetry.circuitBreaker?.reason || 'turn/failure limit reached'}. Human review required.`;
    }

    return {
      worktree: telemetry.path,
      branch: telemetry.branch || 'unknown',
      is_deadlocked: isDeadlocked,
      deadlock_probability: isDeadlocked ? 1.0 : 0.0,
      bottleneck_cause: cause,
      recommended_triage: triage,
      urgency: isDeadlocked ? 3 : 0,
      triage_hint: fallbackHint,
      advisory_only: true,
      fallback: true,
      observed_at: new Date().toISOString()
    };
  }
}

/**
 * State debouncer and consecutive observation tracker.
 * Ensures that single transient blips do not cause alert flapping.
 */
export class SupervisorStateTracker {
  constructor(options = {}) {
    this.minConsecutive = options.minConsecutive ?? 2;
    this.history = new Map(); // worktreePath -> { count: number, lastReport: object, firstSeen: number }
  }

  /**
   * Records an observation and returns whether the alert has reached the debounced threshold.
   * 
   * @param {object} advisoryReport - Output from auditWorktreeLiveness
   * @returns {{ shouldAlert: boolean, consecutiveCount: number, report: object }}
   */
  record(advisoryReport) {
    const key = advisoryReport.worktree;
    const now = Date.now();

    if (!advisoryReport.is_deadlocked || advisoryReport.bottleneck_cause === 'insufficient_evidence') {
      this.history.delete(key);
      return { shouldAlert: false, consecutiveCount: 0, report: advisoryReport };
    }

    const prev = this.history.get(key) || { count: 0, firstSeen: now };
    const newCount = prev.count + 1;
    this.history.set(key, { count: newCount, lastReport: advisoryReport, firstSeen: prev.firstSeen });

    // Permission gates and circuit breaker trips escalate immediately; others require minConsecutive sweeps
    const isImmediate = advisoryReport.bottleneck_cause === 'permission_gate' ||
                        advisoryReport.bottleneck_cause === 'circuit_breaker_tripped';
    const shouldAlert = isImmediate || newCount >= this.minConsecutive;

    return {
      shouldAlert,
      consecutiveCount: newCount,
      report: advisoryReport
    };
  }

  clear(worktreePath) {
    this.history.delete(worktreePath);
  }

  getTracked() {
    return Array.from(this.history.entries()).map(([path, data]) => ({
      path,
      consecutiveCount: data.count,
      firstSeen: data.firstSeen,
      lastReport: data.lastReport
    }));
  }
}
