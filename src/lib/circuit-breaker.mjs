/**
 * Circuit Breaker & Turn Budget Manager.
 *
 * Inspired by Paperclip's atomic budget & iteration controls, adapted for
 * Zero-dependency Node.js.
 *
 * Prevents:
 * 1. Runaway agent iteration loops (default 15 turns).
 * 2. Rapid repeated test/build thrash (consecutive failure cap).
 * 3. Violations of tier & subscription allowance policies.
 */

export const DEFAULT_MAX_TURNS = 15;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export class TaskCircuitBreaker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxTurns=15] - Maximum permitted turns before pause
   * @param {number} [options.maxConsecutiveFailures=3] - Maximum consecutive failed attempts
   * @param {string} [options.harness] - Harness name
   * @param {string} [options.worktree] - Worktree path
   */
  constructor({
    maxTurns = DEFAULT_MAX_TURNS,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
    harness = 'unknown',
    worktree = ''
  } = {}) {
    this.maxTurns = maxTurns;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.harness = harness;
    this.worktree = worktree;

    this.state = {
      turns: 0,
      consecutiveFailures: 0,
      tripped: false,
      reason: null,
      trippedAt: null,
      totalFailures: 0,
      recentActions: []
    };
  }

  /**
   * Ingests a new turn event. Trips if turn count reaches maxTurns.
   *
   * @param {number} [turnNumber]
   * @returns {object} Updated circuit breaker state
   */
  recordTurn(turnNumber) {
    if (typeof turnNumber === 'number') {
      this.state.turns = turnNumber;
    } else {
      this.state.turns += 1;
    }

    if (this.state.turns >= this.maxTurns && !this.state.tripped) {
      this.trip(`turn_limit_exceeded: ${this.state.turns}/${this.maxTurns} turns`);
    }

    return this.getStatus();
  }

  /**
   * Ingests a tool execution or test execution outcome.
   *
   * @param {boolean} success - Whether action succeeded
   * @param {string} [actionDesc] - Optional description (e.g. 'npm test')
   * @returns {object} Updated circuit breaker state
   */
  recordOutcome(success, actionDesc = '') {
    if (actionDesc) {
      this.state.recentActions.push({
        action: actionDesc.slice(0, 150),
        success: Boolean(success),
        time: Date.now()
      });
      if (this.state.recentActions.length > 10) {
        this.state.recentActions.shift();
      }
    }

    if (success) {
      this.state.consecutiveFailures = 0;
    } else {
      this.state.consecutiveFailures += 1;
      this.state.totalFailures += 1;
      if (this.state.consecutiveFailures >= this.maxConsecutiveFailures && !this.state.tripped) {
        this.trip(
          `consecutive_failures_exceeded: ${this.state.consecutiveFailures} failures on '${actionDesc || 'action'}'`
        );
      }
    }

    return this.getStatus();
  }

  /**
   * Checks subscription allowance rules against the tier policy.
   *
   * @param {object} routingPolicy
   * @param {string} targetProvider
   * @returns {{ allowed: boolean, reason?: string }}
   */
  validateAllowance(routingPolicy, targetProvider) {
    const prov = String(targetProvider || '').toLowerCase();
    // Rule: Never route metered OpenRouter when OpenCode Go / Perplexity subscription has capacity
    if (prov.includes('openrouter') && routingPolicy?.hasSubscriptionCapacity) {
      this.trip('allowance_policy_breach: metered OpenRouter used while subscription allowance available');
      return { allowed: false, reason: this.state.reason };
    }
    return { allowed: true };
  }

  /**
   * Trips the breaker with a specific reason.
   *
   * @param {string} reason
   */
  trip(reason) {
    this.state.tripped = true;
    this.state.reason = reason;
    this.state.trippedAt = new Date().toISOString();
  }

  /**
   * Resets the breaker (e.g., when human grants continuation).
   *
   * @param {number} [additionalTurns=10]
   */
  reset(additionalTurns = 10) {
    this.state.tripped = false;
    this.state.reason = null;
    this.state.trippedAt = null;
    this.state.consecutiveFailures = 0;
    this.maxTurns += additionalTurns;
  }

  /**
   * Current status summary.
   */
  getStatus() {
    return {
      tripped: this.state.tripped,
      reason: this.state.reason,
      turns: this.state.turns,
      maxTurns: this.maxTurns,
      consecutiveFailures: this.state.consecutiveFailures,
      trippedAt: this.state.trippedAt,
      harness: this.harness,
      worktree: this.worktree
    };
  }

  toJSON() {
    return {
      maxTurns: this.maxTurns,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      harness: this.harness,
      worktree: this.worktree,
      state: this.state
    };
  }

  static fromJSON(data) {
    if (!data) return new TaskCircuitBreaker();
    const breaker = new TaskCircuitBreaker({
      maxTurns: data.maxTurns,
      maxConsecutiveFailures: data.maxConsecutiveFailures,
      harness: data.harness,
      worktree: data.worktree
    });
    if (data.state) {
      breaker.state = { ...data.state };
    }
    return breaker;
  }
}
