import { BaseHarnessAdapter } from './base.mjs';

/**
 * Adapter for Anthropic Claude Code CLI output.
 */
export class ClaudeCodeAdapter extends BaseHarnessAdapter {
  constructor(options = {}) {
    super('claude-code', options);
  }

  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Detect tool calls: e.g., "⏺ Running Bash: ...", "⏺ FileEdit: ...", "Bash(...)", "Tool: bash"
    const toolMatch = trimmed.match(/(?:⏺\s*Running\s+|Tool:\s*|Running\s+)?(Bash|FileEdit|Glob|Grep|View|Write|Read|Task)\b(?:\s*[:\(]\s*(.*))?/i);
    if (toolMatch) {
      const toolName = toolMatch[1].toLowerCase();
      const toolInput = toolMatch[2] ? toolMatch[2].replace(/\)+$/, '').trim() : '';
      return {
        type: 'tool_call',
        harness: this.name,
        tool: toolName,
        input: toolInput.slice(0, 300),
        timestamp: Date.now()
      };
    }

    // Detect turn indicators or prompts
    if (/^(?:Assistant|Claude|Agent):|^(?:User|Prompt):|^>\s+/i.test(trimmed)) {
      this.currentTurn += 1;
      return {
        type: 'turn_start',
        harness: this.name,
        turn: this.currentTurn,
        line: trimmed.slice(0, 200),
        timestamp: Date.now()
      };
    }

    // Detect permission / approval escalation
    if (/pending\s*permission|approval\s*required|allow\s+.*\(y\/n\)/i.test(trimmed)) {
      return {
        type: 'permission_prompt',
        harness: this.name,
        prompt: trimmed.slice(0, 300),
        timestamp: Date.now()
      };
    }

    // Detect token usage or cost summaries
    const tokenMatch = trimmed.match(/tokens?:\s*([0-9][0-9,]*)\s*(?:in|prompt)?\s*,?\s*([0-9][0-9,]*)\s*(?:out|completion)?/i);
    if (tokenMatch) {
      const inTokens = parseInt(tokenMatch[1].replace(/,/g, ''), 10) || 0;
      const outTokens = parseInt(tokenMatch[2].replace(/,/g, ''), 10) || 0;
      return {
        type: 'token_usage',
        harness: this.name,
        inputTokens: inTokens,
        outputTokens: outTokens,
        timestamp: Date.now()
      };
    }

    // Cost summaries: e.g. "Cost: $0.04"
    const costMatch = trimmed.match(/cost:\s*\$([0-9\.]+)/i);
    if (costMatch) {
      return {
        type: 'cost_summary',
        harness: this.name,
        costDollars: parseFloat(costMatch[1]),
        timestamp: Date.now()
      };
    }

    // Errors
    if (/^(?:Error|Fatal|Exception|Panic):/i.test(trimmed)) {
      return {
        type: 'error',
        harness: this.name,
        message: trimmed,
        timestamp: Date.now()
      };
    }

    return null;
  }
}
