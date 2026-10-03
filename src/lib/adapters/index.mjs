import { BaseHarnessAdapter } from './base.mjs';
import { ClaudeCodeAdapter } from './claude-code.mjs';
import { AcpAdapter } from './acp.mjs';

export { BaseHarnessAdapter, ClaudeCodeAdapter, AcpAdapter };

/**
 * Factory creating the right adapter for a given harness identifier.
 *
 * @param {string} harnessName - E.g. 'claude', 'cursor', 'codex', 'opencode', 'antigravity'
 * @param {object} [options]
 * @returns {BaseHarnessAdapter}
 */
export function getAdapterForHarness(harnessName, options = {}) {
  const norm = String(harnessName || '').toLowerCase().trim();

  if (norm.includes('claude')) {
    return new ClaudeCodeAdapter(options);
  }
  if (norm.includes('cursor') || norm.includes('acp')) {
    return new AcpAdapter(options);
  }
  // Generic / CLI fallback for codex, opencode, antigravity
  return new BaseHarnessAdapter(norm || 'generic', options);
}
