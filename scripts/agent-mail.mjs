#!/usr/bin/env node
// scripts/agent-mail.mjs — In-House AgentMail CLI with Zero-Config Context Auto-Detection
//
// Zero-maintenance, zero-dependency inter-agent communication, auto-context resolution,
// and dispatcher wakeup.
//
// Standard Lifecycle Types:
//   - ready-for-review       (Writer -> Reviewer: implementation complete, negative control proven)
//   - review-feedback        (Reviewer -> Writer: critique, gate failed, revisions needed)
//   - review-approved        (Reviewer -> Dispatcher: approved, negative control validated)
//   - credit-handoff         (Agent -> Agent: credit/context limit reached, state saved)
//   - blocker-help           (Agent -> Dispatcher/human: ambiguous spec or missing dependency)
//   - singleton-escalation   (Agent -> Apex reviewer/human: singleton boundary alert)
//   - speculative-dispatch   (Dispatcher -> Worker: speculative exploration task)
//   - memory-sync            (Reviewer/Agent -> Memory/Wiki: durable knowledge captured)
//   - auto-prune             (Auto-prune engine -> Dispatcher: cleaned up safe worktrees)
//
// Usage:
//   node scripts/agent-mail.mjs send [--to dispatcher] [--type ready-for-review] [--subject "PR #264 audited"]
//   node scripts/agent-mail.mjs check                  (auto-checks mailbox for current worktree/role)
//   node scripts/agent-mail.mjs list [--to dispatcher] (lists messages with optional filter)
//   node scripts/agent-mail.mjs ack --id <id>          (marks message as read)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIL_FILE = join(ROOT, 'config', 'agent-mail.json');
const SERVER_URL = process.env.SWARM_SERVER_URL || 'http://127.0.0.1:8766';

const VALID_TYPES = new Set([
  'ready-for-review',
  'review-feedback',
  'review-approved',
  'credit-handoff',
  'blocker-help',
  'singleton-escalation',
  'speculative-dispatch',
  'memory-sync',
  'auto-prune'
]);

// Auto-detect current git worktree, branch, repo, and role from environment
function detectContext() {
  let cwd = process.cwd().replace(/\\/g, '/');
  let branch = '';
  let repo = '';
  let worktree = cwd;
  let role = 'worker';

  try {
    branch = execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().replace(/\\/g, '/');

    worktree = topLevel;
    repo = basename(topLevel);
  } catch {}

  // Check local checkpoint.json for explicit role or goal
  const cpPath = join(worktree, 'checkpoint.json');
  if (existsSync(cpPath)) {
    try {
      const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
      if (cp.node) role = cp.node;
      else if (branch.includes('review') || (cp.goal && /review/i.test(cp.goal))) role = 'reviewer';
      else if (branch.includes('audit')) role = 'auditor';
    } catch {}
  }

  // Detect harness from environment if available
  const harness = process.env.AGENT_HARNESS || 
                  (process.env.GEMINI_CLI ? 'gemini' : '') || 
                  (process.env.CLAUDE_CODE ? 'claude' : '') || 
                  'agent';

  return {
    branch,
    repo,
    worktree,
    role,
    harness,
    senderId: `${harness}:${role}`
  };
}

function loadMailbox() {
  if (existsSync(MAIL_FILE)) {
    try {
      return JSON.parse(readFileSync(MAIL_FILE, 'utf8'));
    } catch {}
  }
  return { messages: [] };
}

function saveMailbox(box) {
  const dir = dirname(MAIL_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MAIL_FILE, JSON.stringify(box, null, 2), 'utf8');
}

// Parse CLI flags
const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name, def = '') {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return def;
}

async function sendMail() {
  const ctx = detectContext();

  const to = getFlag('to', 'dispatcher');
  const from = getFlag('from', ctx.senderId);
  const type = getFlag('type', 'ready-for-review');
  const subject = getFlag('subject', 'Work completed');
  const body = getFlag('body', '');
  const branch = getFlag('branch', ctx.branch);
  const worktree = getFlag('worktree', ctx.worktree);
  const repo = getFlag('repo', ctx.repo);

  if (!VALID_TYPES.has(type)) {
    console.warn(`[!] Note: "${type}" is non-standard. Recommended standard types: ${[...VALID_TYPES].join(', ')}`);
  }

  const message = {
    id: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    from,
    to,
    type,
    subject,
    body,
    branch,
    worktree,
    repo,
    read: false
  };

  // Try sending via HTTP server first (triggers live SSE & UI alerts)
  try {
    const res = await fetch(`${SERVER_URL}/api/mail/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      console.log(`✓ AgentMail sent to [${to}] via Swarm Server (ID: ${message.id})`);
      if (branch) console.log(`  Context: branch [${branch}] in repo [${repo}]`);
      return;
    }
  } catch {
    // Fallback directly to local file persistence if server isn't running
  }

  const box = loadMailbox();
  box.messages.unshift(message);
  saveMailbox(box);
  console.log(`✓ AgentMail saved locally to [${to}] (ID: ${message.id})`);
  if (branch) console.log(`  Context: branch [${branch}] in repo [${repo}]`);
}

function checkMail() {
  const ctx = detectContext();
  const box = loadMailbox();
  
  // Filter messages relevant to this worktree, branch, or role
  const relevant = box.messages.filter((m) => {
    if (!ctx.branch && !ctx.role) return true;
    const matchBranch = m.branch && ctx.branch && m.branch.toLowerCase() === ctx.branch.toLowerCase();
    const matchWorktree = m.worktree && ctx.worktree && m.worktree.toLowerCase() === ctx.worktree.toLowerCase();
    const matchRole = m.to && ctx.role && (m.to.toLowerCase() === ctx.role.toLowerCase() || m.to.toLowerCase() === 'all');
    return matchBranch || matchWorktree || matchRole;
  });

  console.log(`\n📬 Worktree Inbox for [${ctx.role}@${ctx.branch || 'workspace'}] (${relevant.length} messages):\n`);
  if (!relevant.length) {
    console.log('  (No messages for current worktree context. Run `list` to view all messages)\n');
    return;
  }
  renderMessages(relevant);
}

function listMail() {
  const to = getFlag('to', '');
  const type = getFlag('type', '');
  const box = loadMailbox();
  let msgs = box.messages;
  if (to) msgs = msgs.filter((m) => m.to.toLowerCase() === to.toLowerCase());
  if (type) msgs = msgs.filter((m) => m.type.toLowerCase() === type.toLowerCase());

  console.log(`\n📬 Global AgentMail Inbox (${msgs.length} messages):\n`);
  if (!msgs.length) {
    console.log('  (No messages found)\n');
    return;
  }
  renderMessages(msgs);
}

function renderMessages(msgs) {
  for (const m of msgs.slice(0, 20)) {
    const status = m.read ? ' ' : '●';
    console.log(` ${status} [${m.id}] ${m.timestamp.slice(11, 19)} | From: ${m.from} -> To: ${m.to} | [${m.type}]`);
    console.log(`   Subject: ${m.subject}`);
    if (m.branch) console.log(`   Context: ${m.repo ? m.repo + ' : ' : ''}${m.branch}`);
    if (m.body) console.log(`   Body:    ${m.body.slice(0, 100)}${m.body.length > 100 ? '...' : ''}`);
    console.log('');
  }
}

function ackMail() {
  const id = getFlag('id', '');
  if (!id) {
    console.error('Error: --id is required');
    process.exit(1);
  }
  const box = loadMailbox();
  const msg = box.messages.find((m) => m.id === id);
  if (!msg) {
    console.error(`Message ${id} not found.`);
    process.exit(1);
  }
  msg.read = true;
  saveMailbox(box);
  console.log(`✓ Acknowledged message ${id}`);
}

if (cmd === 'send') {
  await sendMail();
} else if (cmd === 'check') {
  checkMail();
} else if (cmd === 'list') {
  listMail();
} else if (cmd === 'ack') {
  ackMail();
} else {
  console.log('Usage: node scripts/agent-mail.mjs [send|check|list|ack]');
  console.log('  send   [--to <role>] [--type <type>] [--subject <text>] [--body <text>]');
  console.log('  check  (checks inbox filtered to current worktree & branch context)');
  console.log('  list   [--to <role>] [--type <type>]');
  console.log('  ack    --id <msg_id>');
}
