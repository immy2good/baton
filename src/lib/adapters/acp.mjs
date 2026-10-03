import { BaseHarnessAdapter } from './base.mjs';

/**
 * Adapter for Agent Client Protocol (ACP) JSON-RPC streams.
 * Used by Cursor ACP, Claude ACP, and compatible protocol runners.
 */
export class AcpAdapter extends BaseHarnessAdapter {
  constructor(options = {}) {
    super('acp', options);
  }

  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Check if line is valid JSON-RPC
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const msg = JSON.parse(trimmed);
        return this.parseJsonRpc(msg);
      } catch {
        // Not valid JSON, fall through to text parsing
      }
    }

    // Text fallback for ACP process wrappers
    if (/pending\s*permission|permit/i.test(trimmed)) {
      return {
        type: 'permission_prompt',
        harness: this.name,
        prompt: trimmed.slice(0, 300),
        timestamp: Date.now()
      };
    }

    return super.parseLine(line);
  }

  parseJsonRpc(msg) {
    const method = msg.method || '';
    const params = msg.params || {};

    // Tool call notification or request
    if (method.includes('tool') || method === 'tools/call' || method === 'tool/call') {
      const toolName = params.name || params.tool || 'unknown';
      const input = typeof params.arguments === 'string'
        ? params.arguments
        : JSON.stringify(params.arguments || params.input || '');

      return {
        type: 'tool_call',
        harness: this.name,
        tool: toolName.toLowerCase(),
        input: input.slice(0, 300),
        id: msg.id,
        timestamp: Date.now()
      };
    }

    // Turn / prompt boundary
    if (method.includes('prompt') || method.includes('turn') || method === 'session/prompt') {
      this.currentTurn += 1;
      return {
        type: 'turn_start',
        harness: this.name,
        turn: this.currentTurn,
        id: msg.id,
        timestamp: Date.now()
      };
    }

    // Permission request
    if (method.includes('permission') || method === 'session/request_permission') {
      return {
        type: 'permission_prompt',
        harness: this.name,
        prompt: params.reason || params.message || 'Permission required',
        id: msg.id,
        timestamp: Date.now()
      };
    }

    // Error response
    if (msg.error) {
      return {
        type: 'error',
        harness: this.name,
        message: typeof msg.error === 'string' ? msg.error : msg.error.message || 'JSON-RPC error',
        code: msg.error.code,
        timestamp: Date.now()
      };
    }

    return null;
  }
}
