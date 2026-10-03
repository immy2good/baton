import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseHarnessAdapter, ClaudeCodeAdapter, AcpAdapter, getAdapterForHarness } from '../src/lib/adapters/index.mjs';

test('BaseHarnessAdapter parses lines and buffers chunks correctly', () => {
  const adapter = new BaseHarnessAdapter('test-harness');
  const chunk1 = 'Line 1 normal\nError: something broke\nIncomplete';
  const events1 = adapter.parseChunk(chunk1);

  assert.equal(events1.length, 1);
  assert.equal(events1[0].type, 'error');
  assert.ok(events1[0].message.includes('something broke'));

  const chunk2 = ' line completed\n';
  const events2 = adapter.parseChunk(chunk2);
  assert.equal(events2.length, 0);
  assert.equal(adapter.buffer, '');
});

test('ClaudeCodeAdapter extracts tool calls, turns, tokens, and permissions', () => {
  const adapter = new ClaudeCodeAdapter();

  const logLines = [
    '⏺ Running Bash: npm test',
    'Assistant: I will now examine the results.',
    'Tool: FileEdit: src/lib/supervisor.mjs',
    'Tokens: 1,500 prompt, 350 completion',
    'Cost: $0.08',
    'Pending permissions for git push --force'
  ].join('\n') + '\n';

  const events = adapter.parseChunk(logLines);
  assert.equal(events.length, 6);

  // 1. Tool call
  assert.equal(events[0].type, 'tool_call');
  assert.equal(events[0].tool, 'bash');
  assert.equal(events[0].input, 'npm test');

  // 2. Turn start
  assert.equal(events[1].type, 'turn_start');
  assert.equal(events[1].turn, 1);

  // 3. Tool call 2
  assert.equal(events[2].type, 'tool_call');
  assert.equal(events[2].tool, 'fileedit');

  // 4. Token usage
  assert.equal(events[3].type, 'token_usage');
  assert.equal(events[3].inputTokens, 1500);
  assert.equal(events[3].outputTokens, 350);

  // 5. Cost summary
  assert.equal(events[4].type, 'cost_summary');
  assert.equal(events[4].costDollars, 0.08);

  // 6. Permission prompt
  assert.equal(events[5].type, 'permission_prompt');
  assert.ok(events[5].prompt.includes('git push --force'));
});

test('AcpAdapter parses JSON-RPC methods and text fallbacks', () => {
  const adapter = new AcpAdapter();

  const rpcLines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text: 'Fix bug' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'edit_file', arguments: { path: 'a.js' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: { reason: 'Elevate root' } }),
    'Plain text error: socket closed'
  ].join('\n') + '\n';

  const events = adapter.parseChunk(rpcLines);
  assert.equal(events.length, 4);

  assert.equal(events[0].type, 'turn_start');
  assert.equal(events[0].turn, 1);

  assert.equal(events[1].type, 'tool_call');
  assert.equal(events[1].tool, 'edit_file');

  assert.equal(events[2].type, 'permission_prompt');
  assert.equal(events[2].prompt, 'Elevate root');

  assert.equal(events[3].type, 'error');
});

test('getAdapterForHarness returns correct adapter instances', () => {
  assert.ok(getAdapterForHarness('claude') instanceof ClaudeCodeAdapter);
  assert.ok(getAdapterForHarness('claude-code') instanceof ClaudeCodeAdapter);
  assert.ok(getAdapterForHarness('cursor-acp') instanceof AcpAdapter);
  assert.ok(getAdapterForHarness('acp') instanceof AcpAdapter);
  assert.ok(getAdapterForHarness('codex') instanceof BaseHarnessAdapter);
});

test('BaseHarnessAdapter tailLog reads newly appended bytes non-invasively', () => {
  const tmpPath = join(tmpdir(), `test-tail-${Date.now()}.log`);
  writeFileSync(tmpPath, 'Line 1\n');

  const adapter = new ClaudeCodeAdapter();
  let events = adapter.tailLog(tmpPath);
  assert.equal(events.length, 0);

  // Append new event
  writeFileSync(tmpPath, '⏺ Running Bash: git status\n', { flag: 'a' });
  events = adapter.tailLog(tmpPath);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tool_call');
  assert.equal(events[0].tool, 'bash');

  try {
    unlinkSync(tmpPath);
  } catch {}
});
