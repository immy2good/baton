#!/usr/bin/env node
// baton swarm map: live agents, worktrees and Jev dispatch triage in one page.
//
// Combines:
// - Running agents, from the configured launcher (src/lib/launcher.mjs)
// - Git worktree state & dirty tracking across network repos
// - Live GitHub PR tracking & review status
// - checkpoint.json inspection for in-flight goals & proven claims
// - Real-time TypeSafe Jev System One sub-second intent, risk, and diamond triage
// - Interactive Quick Dispatcher & Graph Visualizer
//
// Usage:
//   node scripts/swarm-map.mjs            # http://127.0.0.1:8766
//   PORT=9000 node scripts/swarm-map.mjs
//   node scripts/swarm-map.mjs --json     # one snapshot, no server

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { choice, score, noul, queryJev, getApiKey } from '../src/lib/typesafe.mjs';
import { apexReviewDecision } from '../src/lib/review-policy.mjs';
import { loadRoster, resolveDispatch, formatReviewDiamond } from '../src/lib/roster.mjs';
import { escalationDecision, formatEscalation, APEX_NOUL_THRESHOLD, NOUL_FLOOR } from '../src/lib/triage-gate.mjs';
import { countActiveNodes } from '../src/lib/capacity.mjs';
import { listAgents, resolveLauncherName } from '../src/lib/launcher.mjs';
import { classify } from '../src/lib/offline-classify.mjs';
import { findAgentForWorktree, pruneDecision, samePath, MIN_PRUNE_AGE_MS } from '../src/lib/worktree-safety.mjs';
import { auditWorktreeLiveness, SupervisorStateTracker } from '../src/lib/supervisor.mjs';
import { formatTwoLineSummary } from '../src/lib/preflight.mjs';
import { getAdapterForHarness } from '../src/lib/adapters/index.mjs';
import { TaskCircuitBreaker } from '../src/lib/circuit-breaker.mjs';

// Circuit breaker & adapter registry per worktree
const WORKTREE_BREAKERS = new Map();
const WORKTREE_ADAPTERS = new Map();

function getOrCreateBreaker(worktreePath, harness) {
  let b = WORKTREE_BREAKERS.get(worktreePath);
  if (!b) {
    b = new TaskCircuitBreaker({ worktree: worktreePath, harness, maxTurns: 15 });
    WORKTREE_BREAKERS.set(worktreePath, b);
  }
  return b;
}

function getOrCreateAdapter(worktreePath, harness) {
  let a = WORKTREE_ADAPTERS.get(worktreePath);
  if (!a) {
    a = getAdapterForHarness(harness);
    WORKTREE_ADAPTERS.set(worktreePath, a);
  }
  return a;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config', 'swarm-map.json');

// One roster per process: three independent loadRoster() calls per run re-read the
// profiles and could, mid-edit, disagree with each other.
let ROSTER_CACHE = null;
const roster = () => (ROSTER_CACHE ??= loadRoster());

// Repos to watch come from config/swarm-map.json (gitignored; copy
// config/examples/swarm-map.json). With no config, the map watches baton itself.
const DEFAULTS = {
  repos: [{ name: 'baton', path: ROOT.replace(/\\/g, '/'), slug: '' }],
  // Where dispatched worktrees are created. Default: a `worktrees` folder next to the repo.
  worktreeBase: '',
  // Branches the auto-prune never touches.
  protectedBranches: ['main', 'master', 'develop'],
  lanes: {
    claude: 'orchestrator',
    codex: 'worker',
    cursor: 'worker',
    antigravity: 'worker',
    opencode: 'reviewer',
    perplexity: 'research'
  }
};

function config() {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return DEFAULTS;
  }
}

function run(cmd, args, opts = {}) {
  const isWin = process.platform === 'win32';
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 15000,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    shell: isWin
  });
}

// --- Sources & Introspection ---

function launcherAgents() {
  return listAgents();
}

function worktrees(repo) {
  if (!existsSync(repo.path)) {
    return { ok: false, reason: `repo path not found: ${repo.path}` };
  }
  try {
    const out = run('git', ['-C', repo.path, 'worktree', 'list', '--porcelain']);
    const trees = [];
    let cur = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim().replace(/\\/g, '/') };
      else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 13);
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '').trim();
      else if (line.trim() === '') {
        if (cur.path) trees.push({ ...cur, repo: repo.name, repoSlug: repo.slug });
        cur = {};
      }
    }
    if (cur.path) trees.push({ ...cur, repo: repo.name, repoSlug: repo.slug });
    return { ok: true, value: trees };
  } catch {
    return { ok: false, reason: `git unreadable: ${repo.name}` };
  }
}

// A linked worktree's `.git` is a FILE written once by `git worktree add`; its
// birth time is the worktree's age. Unknown age -> null -> never prunable.
function worktreeAgeMs(path) {
  try {
    const st = statSync(join(path, '.git'));
    const born = st.birthtimeMs || st.ctimeMs;
    return born ? Date.now() - born : null;
  } catch {
    return null;
  }
}

function dirty(path) {
  try {
    return run('git', ['-C', path, 'status', '--porcelain'], { timeout: 8000 }).trim().length > 0;
  } catch {
    return false;
  }
}

function pullRequests(repo) {
  if (!repo.slug) return { ok: true, value: [] }; // no GitHub slug configured: nothing to ask gh about
  try {
    const out = run(process.platform === 'win32' ? 'gh.exe' : 'gh', [
      'pr', 'list', '--repo', repo.slug, '--state', 'open', '--limit', '25',
      '--json', 'number,title,headRefName,isDraft,reviewDecision,mergeable,url'
    ], { timeout: 20000 });
    return { ok: true, value: JSON.parse(out).map((p) => ({ ...p, repo: repo.name })) };
  } catch {
    return { ok: false, reason: `gh unreachable: ${repo.slug}` };
  }
}

function loadCheckpoint(treePath) {
  try {
    const cpPath = join(treePath, 'checkpoint.json');
    if (existsSync(cpPath)) {
      const data = JSON.parse(readFileSync(cpPath, 'utf8'));
      return {
        goal: data.goal || '',
        ticket: data.ticket || '',
        node: data.node || '',
        proven: Array.isArray(data.proven) ? data.proven : [],
        next: data.next || '',
        reviewer: data.reviewer || '',
        blocked: Array.isArray(data.blocked) ? data.blocked : [],
        updated_at: data.updated_at || '',
        status: data.status || ''
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function loadReceipt(treePath) {
  try {
    const rcPath = join(treePath, 'receipt.json');
    if (existsSync(rcPath)) {
      const data = JSON.parse(readFileSync(rcPath, 'utf8'));
      const capture = typeof data.capture === 'string' ? data.capture.trim() : '';
      const verified = Array.isArray(data.verified) ? data.verified : [];
      const hasNegativeControl = verified.some((v) => /negative\s*control|failed\s*first|asserted\s*failure|proved\s*absence|rejected\s*invalid/i.test(v));
      const hasSingletonBreach = /production|deploy|live\s*cms|signing\s*key/i.test(capture + ' ' + verified.join(' '));
      const isComplete = capture.length > 0 && verified.length > 0;
      
      let status = 'incomplete';
      let badge = 'WIP';
      if (hasSingletonBreach) {
        status = 'breach';
        badge = '🚨 Breach';
      } else if (hasNegativeControl && isComplete) {
        status = 'verified';
        badge = '🟢 Verified';
      } else if (isComplete) {
        status = 'no-negative-control';
        badge = '🟡 No Neg Control';
      }

      return {
        exists: true,
        capture,
        verified,
        hasNegativeControl,
        hasSingletonBreach,
        status,
        badge
      };
    }
  } catch {}
  return null;
}

function gateOf(tree, prs) {
  const pr = prs.find((p) => p.headRefName === tree.branch);
  if (tree.checkpoint && tree.checkpoint.status === 'ready-for-review') {
    return { gate: 'review', label: 'ready for review', pr: pr || null };
  }
  if (!pr) return { gate: tree.dirty ? 'working' : 'branch', label: tree.dirty ? 'uncommitted' : 'no PR' };
  if (pr.reviewDecision === 'APPROVED') return { gate: 'merge', label: `#${pr.number} approved`, pr };
  if (pr.isDraft) return { gate: 'review', label: `#${pr.number} draft`, pr };
  return { gate: 'review', label: `#${pr.number} open`, pr };
}

function dispatchWorktree({ repoName, branch, goal, ticket, writer, reviewer, lane = 'worker', dryRun = false }) {
  const cfg = config();
  const repo = cfg.repos.find((r) => r.name === repoName || r.name.endsWith(repoName));
  if (!repo) {
    throw new Error(`Unknown repo: ${repoName}. Available: ${cfg.repos.map((r) => r.name).join(', ')}`);
  }
  if (!branch || !/^[a-zA-Z0-9/_.-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  const sanitizedSlug = branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
  const worktreeBase = (cfg.worktreeBase || join(dirname(repo.path), 'worktrees')).replace(/\\/g, '/');
  let worktreePath = join(worktreeBase, sanitizedSlug).replace(/\\/g, '/');
  
  let counter = 1;
  while (existsSync(worktreePath)) {
    worktreePath = join(worktreeBase, `${sanitizedSlug}-${counter}`).replace(/\\/g, '/');
    counter++;
  }

  const checkpoint = {
    goal: goal || branch,
    ticket: ticket || '',
    node: writer || 'unassigned',
    lane: lane || 'worker',
    reviewer: reviewer || roster().routing.gate.two_axis,
    proven: [],
    blocked: [],
    next: 'Initial implementation with test & negative control proof',
    status: 'in-progress',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (dryRun) {
    return {
      dryRun: true,
      repo: repo.name,
      repoPath: repo.path,
      branch,
      worktreePath,
      gitCommand: `git -C "${repo.path}" worktree add -b "${branch}" "${worktreePath}"`,
      checkpoint
    };
  }

  execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-b', branch, worktreePath], {
    timeout: 30000
  });

  const cpFile = join(worktreePath, 'checkpoint.json');
  writeFileSync(cpFile, JSON.stringify(checkpoint, null, 2), 'utf8');

  CACHE = { at: 0, value: null };

  return {
    ok: true,
    repo: repo.name,
    branch,
    worktreePath,
    checkpoint
  };
}

// --- TypeSafe Jev System One Integration ---

let JEV_HEALTH_CACHE = { at: 0, value: null };

async function getJevHealth() {
  if (JEV_HEALTH_CACHE.value && Date.now() - JEV_HEALTH_CACHE.at < 45000) {
    return JEV_HEALTH_CACHE.value;
  }
  const key = getApiKey();
  if (!key) {
    JEV_HEALTH_CACHE = { at: Date.now(), value: { ok: false, reason: 'Key unset', latency_ms: 0 } };
    return JEV_HEALTH_CACHE.value;
  }
  const t0 = Date.now();
  try {
    await queryJev("Swarm Heartbeat", {
      is_active: noul("Is the AI coding bus actively executing?")
    });
    const latency_ms = Date.now() - t0;
    JEV_HEALTH_CACHE = { at: Date.now(), value: { ok: true, latency_ms, model: 'jev-latest' } };
  } catch (e) {
    JEV_HEALTH_CACHE = { at: Date.now(), value: { ok: false, reason: e.message, latency_ms: Date.now() - t0 } };
  }
  return JEV_HEALTH_CACHE.value;
}

export async function dispatchTriage(title, desc = '', author = undefined) {
  const state = `Task: ${title}
Details: ${desc}`;
  // Speculative Fan-Out Pre-Flight Gating: 8 operational dimensions evaluated in one ~200ms Jev call
  const questions = {
    domain: choice("What domain does this task belong to?", {
      critical_systems: "Payments, money movement, order execution, or any code where a bug costs real money",
      support_docs: "Customer docs, knowledge base, onboarding, guides",
      auth_security: "Authentication, licensing, permissions, tokens, webhooks",
      web_ui: "Web front-ends, themes, landing pages, CSS layout, copy",
      infrastructure: "Agent tooling, launcher configs, schemas, CI/CD, scripts"
    }),
    work_type: choice("What kind of work is this?", {
      implement: "Write or change behaviour, with tests -- the normal scoped ticket",
      docs: "Documentation, decision record, runbook, handoff or resume note; no behaviour change",
      research: "Answer a question from primary sources; produces a cited brief, not code",
      bulk: "Mechanical churn: renames, formatting, log triage, release notes, summaries"
    }),
    risk_score: score("Rate the operational and financial risk of modifying this code", [
      "Negligible risk (docs, comments, mechanical test rename)",
      "Low to medium risk (isolated UI styling, non-critical helper)",
      "High risk (shared contracts, auth or licensing logic, installer packaging)",
      "Critical risk (money movement, production data, secrets)"
    ]),
    requires_apex_review: noul("Does this task touch money movement, cross-repo contracts, licensing, or security invariants?"),
    requires_negative_control: noul("Does acceptance of this task require proving a defect failed first with a negative control?"),
    touches_singletons: noul("Does this task touch human-held singletons, production credentials, hosting, or live CMS deployment?"),
    requires_live_environment: noul("Does verifying this task require a real device, terminal, or external runtime rather than tests alone?"),
    // No Jev question names a model, harness or agent: Jev cannot know which model
    // has the best track record. It asks what the WORK demands; roster/routing.json
    // maps that to a seat.
    recommended_harness_fit: choice("What capability does this task demand most?", {
      architecture_depth: "Cross-module design, multi-file refactoring, or architecture-grade reasoning",
      determinism: "Strict mutation tests, deterministic probes, compile and build verification",
      throughput: "Fast everyday scoped implementation and mechanical churn",
      breadth: "Balanced front-end, UI and script work across mixed file types"
    })
  };

  const t0 = Date.now();
  const resp = await classify(state, questions);
  const latency_ms = Date.now() - t0;

  const domain = resp.answers.domain?.choice || 'infrastructure';
  const work_type = resp.answers.work_type?.choice || 'implement';
  const risk_score = resp.answers.risk_score?.score ?? 1;

  const reqNegControlProb = resp.answers.requires_negative_control?.noul ?? 0;
  const touchesSingletonsProb = resp.answers.touches_singletons?.noul ?? 0;
  const reqTerminalProb = resp.answers.requires_live_environment?.noul ?? 0;

  // typesafe.mjs returns nouls as `.noul`; `.probability` never existed, so this flag was
  // always false before. Author-aware: frontier does not review frontier.
  // Same gate as scripts/dispatch-triage.mjs, and for the same reason: this path
  // also calls resolveDispatch on Jev's answers, so gating only the CLI would
  // leave the map free to route a classification Jev was not confident about.
  const escalation = escalationDecision({ answers: resp.answers });
  if (escalation.escalate) {
    return {
      title,
      domain,
      work_type,
      risk_score,
      escalate: true,
      escalation_reasons: escalation.reasons,
      probabilities: escalation.probabilities,
      confidences: escalation.confidences,
      target_node: null,
      review_diamond: null,
      // Escalation drops the ROUTING, never the evidence. The preflight nouls are
      // independent of the classification Jev was unsure about, and they are what
      // the human needs in front of them to make the call the gate handed over.
      preflight: {
        requires_negative_control: reqNegControlProb >= NOUL_FLOOR,
        negative_control_prob: reqNegControlProb,
        touches_singletons: touchesSingletonsProb >= NOUL_FLOOR,
        singleton_prob: touchesSingletonsProb,
        requires_live_environment: reqTerminalProb >= NOUL_FLOOR,
        terminal_prob: reqTerminalProb,
        harness_fit: resp.answers.recommended_harness_fit?.choice || 'throughput'
      },
      summary: { formatted: formatEscalation(escalation) },
      meta: { latency_ms, roster_source: null, model: resp.model || 'jev-1.13.0' }
    };
  }

  const apex = apexReviewDecision({
    apexProbability: resp.answers.requires_apex_review?.noul,
    threshold: APEX_NOUL_THRESHOLD,
    author
  });

  const dispatch = resolveDispatch({
    domain,
    workType: work_type,
    riskScore: risk_score,
    requiresApex: apex.required,
    apexWaived: apex.waived,
    author,
    roster: roster(),
    activeNodes: countActiveNodes() ?? 0
  });

  const summary = formatTwoLineSummary({
    riskScore: risk_score,
    domain,
    workKind: work_type,
    flags: {
      touches_critical_path: domain === 'critical_systems' && risk_score >= 2,
      touches_cross_repo_contract: risk_score >= 2,
      requires_human_approval: touchesSingletonsProb >= 0.50,
      requires_negative_control: reqNegControlProb >= 0.50,
      requires_live_environment: reqTerminalProb >= 0.50
    },
    probabilities: {
      critical_path: domain === 'critical_systems' ? 0.9 : 0.1,
      human_approval: touchesSingletonsProb,
      negative_control: reqNegControlProb,
      live_environment: reqTerminalProb
    }
  });

  const triageResult = {
    title,
    domain,
    work_type,
    target_node: dispatch.writer.id,
    risk_score,
    requires_apex_review: dispatch.requires_apex_review,
    apex_waived: dispatch.apex_waived,
    apex_waived_reason: apex.reason || dispatch.apex_waived_reason,
    effective_author: dispatch.effective_author,
    writer_fallback_from: dispatch.writer_fallback_from,
    failsafe_used: dispatch.failsafe_used,
    failsafe_forced: dispatch.failsafe_forced,
    failsafe_reason: dispatch.failsafe_reason,
    at_capacity: dispatch.at_capacity,
    max_active_nodes: dispatch.max_active_nodes,
    summary,
    review_diamond: {
      ...formatReviewDiamond(dispatch),
      // swarm-map's UI reads this field; the CLI does not emit it.
      apex_reviewer: dispatch.requires_apex_review ? dispatch.reviewer.id : null
    },
    preflight: {
      requires_negative_control: reqNegControlProb >= 0.50,
      negative_control_prob: reqNegControlProb,
      touches_singletons: touchesSingletonsProb >= 0.50,
      singleton_prob: touchesSingletonsProb,
      requires_live_environment: reqTerminalProb >= 0.50,
      terminal_prob: reqTerminalProb,
      harness_fit: resp.answers.recommended_harness_fit?.choice || 'throughput'
    },
    meta: {
      latency_ms,
      roster_source: dispatch.roster_source,
      model: resp.model || 'jev-1.13.0'
    }
  };

  // Broadcast preflight event to Swarm Map SSE clients
  broadcastMailEvent({
    id: 'preflight_' + Date.now().toString(36),
    from: 'jev/preflight',
    to: 'all',
    subject: `Preflight: ${domain} (Risk: ${risk_score}/3)`,
    body: `${title}\n\n${summary.formatted}`,
    type: 'preflight_telemetry',
    timestamp: new Date().toISOString()
  });

  return triageResult;
}

// --- Snapshot Assembly ---

let CACHE = { at: 0, value: null };

function snapshot() {
  if (CACHE.value && Date.now() - CACHE.at < 6000) return CACHE.value;
  const value = buildSnapshot();
  CACHE = { at: Date.now(), value };
  return value;
}

function buildSnapshot() {
  const cfg = config();
  const agents = launcherAgents();
  const dark = [];
  if (!agents.ok) dark.push(agents.reason);

  const trees = [];
  const prs = [];
  for (const repo of cfg.repos) {
    const w = worktrees(repo);
    if (w.ok) trees.push(...w.value);
    else dark.push(w.reason);
    const p = pullRequests(repo);
    if (p.ok) prs.push(...p.value);
    else dark.push(p.reason);
  }

  const prHeadRefs = new Set(prs.map((p) => p.headRefName));
  const working = trees
    .filter((t) => /worktrees/i.test(t.path))
    .map((t) => {
      const isDirty = dirty(t.path);
      const checkpoint = loadCheckpoint(t.path);
      const receipt = loadReceipt(t.path);
      // git prints C:/Users/<me>/..., a launcher may report ~\... - compare normalised, never with ===.
      const agent = findAgentForWorktree(agents.value, t.path);
      const harness = agent?.provider?.split('/')[0] || (t.branch?.match(/^(codex|cursor|agy|claude)/)?.[1] ?? '');
      const breaker = getOrCreateBreaker(t.path, harness);
      const adapter = getOrCreateAdapter(t.path, harness);

      // Non-invasive log tailing for turn and tool progression
      const logPath = join(t.path, 'task.log');
      if (existsSync(logPath)) {
        const events = adapter.tailLog(logPath);
        for (const ev of events) {
          if (ev.type === 'turn_start') breaker.recordTurn(ev.turn);
          if (ev.type === 'tool_call') breaker.recordOutcome(true, ev.tool);
          if (ev.type === 'error') breaker.recordOutcome(false, ev.message);
        }
      }

      return {
        ...t,
        dirty: isDirty,
        checkpoint,
        receipt,
        ...gateOf({ ...t, dirty: isDirty, checkpoint }, prs),
        agent: agent || null,
        harness,
        lane: cfg.lanes[harness] || 'worker',
        supervisor: SUPERVISOR_ADVISORIES.get(t.path) || null,
        circuitBreaker: breaker.getStatus()
      };
    })
    .sort((a, b) => {
      const aActive = a.gate !== 'branch' || a.dirty || a.agent ? 1 : 0;
      const bActive = b.gate !== 'branch' || b.dirty || b.agent ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (a.repo + a.branch).localeCompare(b.repo + b.branch);
    });

  const parked = working.filter((w) => w.gate === 'branch' && !w.dirty && !w.agent);
  // `parked` already drops agent-attached worktrees, so pruneDecision's `agent` guard is
  // redundant HERE on purpose: if this pre-filter is ever edited, the guard still holds.
  // Known limit: a launcher succeeding with an EMPTY list (daemon mid-restart) looks
  // like "nobody is working". agentsKnown cannot see that; the minimum-age floor is
  // what protects a live worktree in that window.
  const audit = parked.map((w) => {
    const hasOpenPr = prHeadRefs.has(w.branch);
    const isClean = !w.dirty;
    const isProtected = (cfg.protectedBranches || []).some((b) => w.branch === b || w.branch.endsWith('/' + b)) || cfg.repos.some((r) => samePath(r.path, w.path));
    const decision = pruneDecision({
      isClean,
      hasOpenPr,
      agent: w.agent,
      isProtected,
      agentsKnown: agents.ok,
      ageMs: worktreeAgeMs(w.path)
    });
    const isSafeToPrune = decision.safe;
    return {
      repo: w.repo,
      branch: w.branch || '(detached)',
      path: w.path,
      isSafeToPrune,
      reason: decision.reason
    };
  });

  const mailbox = getMailbox();
  // Mechanical auto-prune notices are purely informational receipts and should not trigger unread alarms
  const unreadCount = mailbox.messages.filter((m) => !m.read && m.type !== 'auto-prune').length;

  return {
    at: new Date().toISOString(),
    dark,
    agents: agents.value || [],
    agentsOk: agents.ok,
    launcher: agents.launcher || null,
    repos: cfg.repos.map((r) => r.name),
    work: working,
    prs,
    audit,
    mail: {
      unread: unreadCount,
      messages: mailbox.messages.slice(0, 25)
    },
    supervisor: {
      count: SUPERVISOR_ADVISORIES.size,
      advisories: Array.from(SUPERVISOR_ADVISORIES.values()),
      alerts: Array.from(SUPERVISOR_ADVISORIES.values()).filter((a) => a.debounced_alert)
    },
    stats: {
      total_worktrees: working.length,
      active_count: working.filter((w) => w.gate !== 'branch' || w.dirty || w.agent).length,
      open_prs: prs.length,
      connected_agents: (agents.value || []).length,
      prunable_count: audit.filter((a) => a.isSafeToPrune).length,
      unread_mail: unreadCount,
      stuck_nodes_count: Array.from(SUPERVISOR_ADVISORIES.values()).filter((a) => a.debounced_alert).length,
      auto_prune_enabled: autoPruneEnabled
    }
  };
}

// --- In-House AgentMail Storage & SSE Broadcaster ---

const MAIL_PATH = join(ROOT, 'config', 'agent-mail.json');
const SSE_CLIENTS = new Set();

function getMailbox() {
  if (existsSync(MAIL_PATH)) {
    try {
      return JSON.parse(readFileSync(MAIL_PATH, 'utf8'));
    } catch {}
  }
  return { messages: [] };
}

function saveMailbox(box) {
  writeFileSync(MAIL_PATH, JSON.stringify(box, null, 2), 'utf8');
}

function broadcastMailEvent(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of SSE_CLIENTS) {
    try {
      client.write(data);
    } catch {
      SSE_CLIENTS.delete(client);
    }
  }
}

// --- Local Inference Health Check ---

async function getLocalModelHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, provider: 'ollama', models: (data.models || []).map((m) => m.name) };
    }
  } catch {}
  return { ok: false, provider: 'local', reason: 'offline' };
}

// --- Automatic Worktree Pruning Engine ---

// Off by default: a sweep that deletes directories is opted into (toggle endpoint or
// SWARM_AUTO_PRUNE=1), never the state a restart silently returns to.
let autoPruneEnabled = process.env.SWARM_AUTO_PRUNE === '1';

function pruneWorktree(repoName, worktreePath, force = true) {
  const cfg = config();
  const repo = cfg.repos.find((r) => r.name === repoName || r.slug?.endsWith(repoName) || repoName?.endsWith(r.name));
  const repoCwd = repo ? repo.path : ROOT;

  const args = ['-C', repoCwd, 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);

  execFileSync('git', args, { timeout: 20000 });

  try {
    execFileSync('git', ['-C', repoCwd, 'worktree', 'prune'], { timeout: 10000 });
  } catch {}

  return { ok: true, path: worktreePath, repo: repoName };
}

function pruneAllSafeWorktrees() {
  CACHE = { at: 0, value: null }; // destructive path: decide on fresh state only
  const snap = buildSnapshot();
  const safeItems = snap.audit.filter((a) => a.isSafeToPrune);
  const results = [];
  const errors = [];

  for (const item of safeItems) {
    try {
      pruneWorktree(item.repo, item.path, true);
      results.push({ repo: item.repo, branch: item.branch, path: item.path });
    } catch (err) {
      errors.push({ path: item.path, error: err.message });
    }
  }

  if (results.length > 0) {
    CACHE = { at: 0, value: null };

    // Record AgentMail notification for the dispatcher
    const box = getMailbox();
    const mail = {
      id: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      from: 'auto-prune',
      to: 'dispatcher',
      type: 'auto-prune',
      subject: `Auto-pruned ${results.length} safe parked worktrees`,
      body: `Cleaned up ${results.length} parked worktrees with clean branches and no open PRs:\n` +
            results.map((r) => ` - [${r.repo}] ${r.branch} (${r.path})`).join('\n'),
      read: false
    };
    box.messages.unshift(mail);
    saveMailbox(box);
    broadcastMailEvent(mail);
  }

  return {
    ok: true,
    pruned_count: results.length,
    pruned: results,
    errors
  };
}

const isMainScript = Boolean(process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase() === process.argv[1].replace(/\\/g, '/').toLowerCase());

// Background Auto-Pruning Schedule: runs every 10 minutes
const AUTO_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
if (isMainScript) {
  setInterval(() => {
    if (autoPruneEnabled) {
      try {
        const res = pruneAllSafeWorktrees();
        if (res.pruned_count > 0) {
          console.log(`[auto-prune] Cleaned up ${res.pruned_count} safe parked worktrees.`);
        }
      } catch (err) {
        console.error('[auto-prune] Periodic run error:', err.message);
      }
    }
  }, AUTO_PRUNE_INTERVAL_MS);
}

// --- Phase 1: Jev Advisory Deadlock & Stuck Node Supervisor ---

const supervisorTracker = new SupervisorStateTracker({ minConsecutive: 2 });
let SUPERVISOR_ADVISORIES = new Map();
let isAuditingSupervisor = false;

async function runSupervisorAudit() {
  if (isAuditingSupervisor) return { running: true };
  isAuditingSupervisor = true;
  const startTime = Date.now();
  const audited = [];

  try {
    const snap = buildSnapshot();
    const trees = snap.work || [];

    for (const w of trees) {
      const ageMs = worktreeAgeMs(w.path);
      const ageHours = ageMs ? Math.round((ageMs / (3600 * 1000)) * 10) / 10 : 0;
      const telemetry = {
        path: w.path,
        branch: w.branch,
        ageHours,
        dirtyCount: w.dirty ? 1 : 0,
        agentStatus: w.agent?.status || 'none',
        agentMessage: w.agent?.message || '',
        circuitBreaker: w.circuitBreaker || null,
        hasPr: Boolean(w.pr)
      };

      try {
        const report = await auditWorktreeLiveness(telemetry, { timeoutMs: 4000 });
        const debounced = supervisorTracker.record(report);
        const record = {
          ...report,
          debounced_alert: debounced.shouldAlert,
          consecutive_count: debounced.consecutiveCount
        };
        SUPERVISOR_ADVISORIES.set(w.path, record);
        audited.push(record);
      } catch (err) {
        // Individual worktree failure should not halt the entire sweep
      }
    }
    CACHE = { at: 0, value: null }; // invalidate snapshot cache so next read includes fresh supervisor state
  } catch (err) {
    console.error('[supervisor] Periodic sweep error:', err.message);
  } finally {
    isAuditingSupervisor = false;
  }

  return {
    ok: true,
    duration_ms: Date.now() - startTime,
    count: audited.length,
    alerts: audited.filter((a) => a.debounced_alert)
  };
}

// Background Supervisor Schedule: runs every 60 seconds
const SUPERVISOR_INTERVAL_MS = 60 * 1000;
if (isMainScript) {
  setInterval(() => {
    runSupervisorAudit().catch(() => {});
  }, SUPERVISOR_INTERVAL_MS);

  // Initial audit run shortly after boot
  setTimeout(() => {
    runSupervisorAudit().catch(() => {});
  }, 4000);
}

// --- Frontend Web UI ---

const PAGE_HTML_PATH = fileURLToPath(new URL('./swarm-map.html', import.meta.url));
function getPage() {
  return readFileSync(PAGE_HTML_PATH, 'utf8');
}

// --- Server Setup ---

if (isMainScript) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(snapshot(), null, 2));
    process.exit(0); // the supervisor timers would otherwise keep a one-shot run alive
  } else {
  const port = Number(process.env.PORT || 8766);
  createServer(async (req, res) => {
    // 1. Snapshot State Endpoint
    if (req.url?.startsWith('/api/state')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
      return;
    }

    // 2. Jev Health Check Endpoint
    if (req.url?.startsWith('/api/jev-health')) {
      const health = await getJevHealth();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health));
      return;
    }

    // 3. Local Model Health Check Endpoint
    if (req.url?.startsWith('/api/local-health')) {
      const health = await getLocalModelHealth();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health));
      return;
    }

    // 3b. Supervisor Advisory GET Endpoint
    if (req.url?.startsWith('/api/supervisor') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        count: SUPERVISOR_ADVISORIES.size,
        advisories: Array.from(SUPERVISOR_ADVISORIES.values()),
        alerts: Array.from(SUPERVISOR_ADVISORIES.values()).filter((a) => a.debounced_alert)
      }));
      return;
    }

    // 3c. Supervisor Audit Trigger POST Endpoint
    if (req.url?.startsWith('/api/supervisor/audit') && req.method === 'POST') {
      runSupervisorAudit().then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 3d. Circuit Breaker Reset POST Endpoint
    if (req.method === 'POST' && req.url?.startsWith('/api/circuit-breaker/reset')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { path, additionalTurns } = JSON.parse(body || '{}');
          if (path && WORKTREE_BREAKERS.has(path)) {
            const b = WORKTREE_BREAKERS.get(path);
            b.reset(additionalTurns || 10);
            CACHE = { at: 0, value: null };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: b.getStatus() }));
          } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Worktree breaker not found' }));
          }
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 4. Jev Quick Triage POST Endpoint
    if (req.method === 'POST' && req.url?.startsWith('/api/triage')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { title, desc, author } = JSON.parse(body || '{}');
          if (!title) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Title is required' }));
            return;
          }
          const result = await dispatchTriage(title, desc, author);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 5. One-Click Worktree Dispatch POST Endpoint
    if (req.method === 'POST' && req.url?.startsWith('/api/dispatch')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body || '{}');
          const result = dispatchWorktree(params);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 6a. Auto-Prune All Safe Worktrees POST Endpoint
    if (req.method === 'POST' && (req.url === '/api/prune-all' || req.url?.startsWith('/api/prune-all?'))) {
      try {
        const result = pruneAllSafeWorktrees();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 6b. Auto-Prune Toggle POST Endpoint
    if (req.method === 'POST' && (req.url === '/api/auto-prune/toggle' || req.url?.startsWith('/api/auto-prune/toggle?'))) {
      autoPruneEnabled = !autoPruneEnabled;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, autoPruneEnabled }));
      return;
    }

    // 6c. Safe Single Worktree Pruning POST Endpoint
    if (req.method === 'POST' && (req.url === '/api/prune' || req.url?.startsWith('/api/prune?'))) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { path, repo, force = true, dryRun = false } = JSON.parse(body || '{}');
          if (!path || !path.includes('worktrees')) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid worktree path' }));
            return;
          }
          // Never trust the client's view: the panel that offered this button may be
          // minutes stale, and an agent may have attached since. Re-decide on fresh
          // state, exactly as the sweep does - same guards, no bypass.
          CACHE = { at: 0, value: null };
          const verdict = buildSnapshot().audit.find((a) => samePath(a.path, path));
          if (!verdict || !verdict.isSafeToPrune) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Refused: worktree is not safe to prune',
              reason: verdict ? verdict.reason : 'Not a parked worktree (in use, has an agent, has a PR gate, or unknown)'
            }));
            return;
          }
          if (dryRun) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ dryRun: true, command: `git worktree remove --force "${path}"` }));
            return;
          }
          const result = pruneWorktree(verdict.repo, verdict.path, force);
          CACHE = { at: 0, value: null };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 7. AgentMail Send POST Endpoint
    if (req.method === 'POST' && req.url?.startsWith('/api/mail/send')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const msg = JSON.parse(body || '{}');
          if (!msg.to || !msg.subject) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'to and subject are required' }));
            return;
          }
          if (!msg.id) {
            msg.id = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
          }
          msg.timestamp = msg.timestamp || new Date().toISOString();
          msg.read = false;

          const box = getMailbox();
          box.messages.unshift(msg);
          saveMailbox(box);
          broadcastMailEvent(msg);

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: msg.id }));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 8. AgentMail Inbox GET Endpoint
    if (req.method === 'GET' && req.url?.startsWith('/api/mail/inbox')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const to = url.searchParams.get('to');
      const unreadOnly = url.searchParams.get('unread') === 'true';

      const box = getMailbox();
      let messages = box.messages;
      if (to) messages = messages.filter((m) => m.to.toLowerCase() === to.toLowerCase());
      if (unreadOnly) messages = messages.filter((m) => !m.read);

      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, count: messages.length, messages }));
      return;
    }

    // 9. AgentMail Ack POST Endpoint
    if (req.method === 'POST' && (req.url?.startsWith('/api/mail/ack') || req.url?.startsWith('/api/mail/ack-all'))) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { id, all } = JSON.parse(body || '{}');
          const box = getMailbox();
          let acked = 0;
          if (all || req.url?.includes('ack-all')) {
            for (const m of box.messages) {
              if (!m.read) { m.read = true; acked++; }
            }
          } else if (id) {
            const msg = box.messages.find((m) => m.id === id);
            if (msg && !msg.read) { msg.read = true; acked = 1; }
          }
          saveMailbox(box);
          CACHE = { at: 0, value: null };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, acked, id: id || 'all' }));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 10. AgentMail SSE Events Stream (Real-Time Wakeup)
    if (req.url?.startsWith('/api/mail/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('retry: 3000\n\n');
      SSE_CLIENTS.add(res);
      req.on('close', () => SSE_CLIENTS.delete(res));
      return;
    }

    // 11. HTML Interface
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(getPage());
  }).listen(port, '127.0.0.1', () => {
    console.log(`baton swarm map: http://127.0.0.1:${port}  (launcher: ${resolveLauncherName()})`);
    console.log(`[auto-prune] ${autoPruneEnabled ? 'ON' : 'OFF (default - set SWARM_AUTO_PRUNE=1 or use the toggle to opt in)'}; `
      + `never prunes a worktree with an agent, an open PR, uncommitted work, an unknown age, or younger than ${MIN_PRUNE_AGE_MS / 3600000}h.`);
  });
}
}
