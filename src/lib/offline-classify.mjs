/**
 * Offline keyword classifier: answers the same typed questions as TypeSafe Jev
 * (choice / score / noul), with no network and no API key.
 *
 * It is deliberately simple and honest about it. Every answer carries a
 * confidence, and when the text gives it nothing to go on the confidence is low,
 * so the triage gate (triage-gate.mjs) escalates to a human instead of guessing.
 * Routing after classification is the same deterministic roster either way.
 *
 * Use `classify()` rather than calling either backend directly: it uses Jev when
 * TYPESAFE_API_KEY is set (unless `offline: true`) and this classifier otherwise.
 */
import { getApiKey, queryJev } from './typesafe.mjs';

export const OFFLINE_MODEL = 'offline-keywords';

/** Extra words per known option key, on top of the words in the option's own description. */
export const KEYWORDS = {
  critical_systems: ['payment', 'payments', 'refund', 'refunds', 'billing', 'invoice', 'checkout', 'money', 'order', 'orders', 'price', 'pricing', 'currency', 'stripe', 'payout', 'trade', 'balance', 'ledger', 'charge'],
  auth_security: ['auth', 'login', 'logout', 'password', 'token', 'tokens', 'oauth', 'jwt', 'permission', 'permissions', 'license', 'licence', 'session', 'webhook', 'secret', 'security', 'sso', 'role', 'roles', 'csrf', 'xss'],
  web_ui: ['css', 'layout', 'page', 'button', 'frontend', 'front-end', 'react', 'html', 'style', 'styling', 'landing', 'theme', 'copy', 'component', 'modal', 'mobile', 'responsive', 'navbar', 'form'],
  infrastructure: ['ci', 'pipeline', 'docker', 'script', 'scripts', 'config', 'schema', 'build', 'tooling', 'agent', 'agents', 'launcher', 'workflow', 'worktree', 'lint', 'deps', 'dependency', 'dependencies', 'readme', 'repo', 'codebase', 'helper', 'helpers', 'functions', 'tests', 'test'],
  support_docs: ['customer', 'customers', 'faq', 'onboarding', 'guide', 'guides', 'help', 'knowledge'],
  implement: ['fix', 'fixes', 'add', 'implement', 'bug', 'feature', 'change', 'update', 'refactor', 'build', 'support', 'handle', 'crash', 'error', 'regression', 'broken', 'make', 'improve', 'allow', 'enable', 'create', 'remove', 'show', 'hide', 'responsive', 'rotate', 'upgrade', 'migrate', 'replace', 'configure', 'set'],
  docs: ['docs', 'doc', 'documentation', 'readme', 'runbook', 'guide', 'adr', 'changelog', 'comment', 'comments', 'typo', 'typos', 'spelling'],
  research: ['research', 'investigate', 'compare', 'evaluate', 'why', 'question', 'spike', 'explore', 'options', 'benchmark'],
  bulk: ['rename', 'renames', 'format', 'formatting', 'typo', 'typos', 'bulk', 'cleanup', 'clean', 'summarise', 'summarize', 'notes', 'mechanical']
};

/** Common verbs that appear in almost every ticket: they count, but only half as much. */
export const WEAK = new Set(['fix', 'fixes', 'add', 'change', 'update', 'make', 'improve', 'create', 'remove', 'show', 'hide', 'clean', 'build', 'support']);

/**
 * A yes/no question names topics ("money movement", "auth"); these expand a topic
 * word in the question into the words a ticket would actually use.
 */
export const EXPANSIONS = {
  money: 'critical_systems', payments: 'critical_systems', payment: 'critical_systems', financial: 'critical_systems',
  auth: 'auth_security', licensing: 'auth_security', security: 'auth_security', 'security-sensitive': 'auth_security', credentials: 'auth_security',
  documentation: 'docs', docs: 'docs'
};

/** Risk bands, highest first. The first band with a hit wins. */
export const RISK_WORDS = [
  [3, ['payment', 'payments', 'refund', 'refunds', 'billing', 'money', 'payout', 'production', 'prod', 'secret', 'secrets', 'credential', 'credentials', 'delete', 'deletion', 'drop', 'ledger', 'charge', 'stripe']],
  [2, ['auth', 'login', 'password', 'token', 'license', 'licence', 'contract', 'api', 'schema', 'migration', 'migrations', 'security', 'installer', 'webhook', 'permission', 'permissions', 'session', 'database']],
  [0, ['typo', 'typos', 'docs', 'readme', 'comment', 'comments', 'rename', 'changelog', 'spelling']]
];

const STOP = new Set(('a an and any are as at be by can code does do for from has have in into is it its of on or that the this to touch touches task with without would require requires requiring change changes modify modifies e.g real rather than only other where costs whether should').split(' '));

export function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map(w => w.replace(/^-+|-+$/g, ''))
    .filter(w => w.length >= 2 && !STOP.has(w));
}

function stateText(state) {
  return typeof state === 'string' ? state : JSON.stringify(state ?? '');
}

function answerChoice(words, q) {
  const opts = q.criteria || q.options || {};
  const keys = Object.keys(opts);
  const raw = keys.map(k => {
    const vocab = new Set([...tokens(opts[k]), ...(KEYWORDS[k] || []), ...tokens(k.replace(/_/g, ' '))]);
    let s = 0;
    for (const w of words) if (vocab.has(w)) s += WEAK.has(w) ? 1 : (KEYWORDS[k] || []).includes(w) ? 2 : 1;
    return s;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  // No signal at all: a uniform split, which is below the confidence floor by design.
  const probs = total === 0 ? raw.map(() => 1 / keys.length) : raw.map(s => s / total);
  let best = 0;
  probs.forEach((p, i) => { if (p > probs[best]) best = i; });
  return {
    choice: keys[best],
    confidence: Number(probs[best].toFixed(2)),
    probabilities: Object.fromEntries(keys.map((k, i) => [k, Number(probs[i].toFixed(2))]))
  };
}

function answerScore(words, q) {
  const n = (q.criteria || []).length || 4;
  const set = new Set(words);
  let band = 1;
  for (const [level, list] of RISK_WORDS) {
    if (list.some(w => set.has(w))) { band = level; break; }
  }
  band = Math.min(band, n - 1);
  const probabilities = {};
  for (let i = 0; i < n; i++) probabilities[i] = i === band ? 0.8 : Math.abs(i - band) === 1 ? 0.1 : 0;
  return { score: band, confidence: 0.8, probabilities };
}

/**
 * Words a yes/no question uses for framing, not for its topic. Matching them made
 * "Did this agent perform ... live production deployment?" fire on any receipt
 * from an `agent/...` branch that mentioned something "live".
 */
const FRAMING = new Set(['did', 'agent', 'agents', 'perform', 'claim', 'action', 'human', 'human-held', 'live', 'such', 'demonstrate', 'rather', 'like', 'specific', 'concrete', 'e.g', 'prior']);

function answerNoul(words, q) {
  const base = tokens(q.instructions).filter(w => !FRAMING.has(w));
  const vocab = new Set(base);
  for (const w of base) for (const k of [].concat(EXPANSIONS[w] || [])) for (const x of KEYWORDS[k] || []) if (!WEAK.has(x)) vocab.add(x);
  const hits = words.filter(w => vocab.has(w)).length;
  return { noul: hits >= 2 ? 0.8 : hits === 1 ? 0.6 : 0.15 };
}

/** Answer a Jev-style question dictionary from keywords. Same return shape as queryJev. */
export function classifyOffline(state, questions) {
  const words = tokens(stateText(state));
  const answers = {};
  for (const [key, q] of Object.entries(questions || {})) {
    if (q.type === 'choice') answers[key] = answerChoice(words, q);
    else if (q.type === 'score') answers[key] = answerScore(words, q);
    else if (q.type === 'noul') answers[key] = answerNoul(words, q);
  }
  return { answers, model: OFFLINE_MODEL, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0 };
}

/** Jev when a key is available (and not `offline`), else the offline classifier. */
export async function classify(state, questions, { offline = false, ...options } = {}) {
  if (!offline && getApiKey()) return queryJev(state, questions, options);
  return classifyOffline(state, questions);
}
