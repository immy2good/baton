import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalisePath, samePath, isPathInside, findAgentForWorktree, pruneDecision, MIN_PRUNE_AGE_MS,
} from '../src/lib/worktree-safety.mjs';

const GIT = 'C:/Users/dev/.paseo/worktrees/1qi0m53u/chore-worktree-env-contract';
const PASEO = 'C:\\Users\\dev\\.paseo\\worktrees\\1qi0m53u\\chore-worktree-env-contract';
const OLD = MIN_PRUNE_AGE_MS + 1;
// Verbatim shape from `paseo ls --json` - the form that actually broke the match.
const PASEO_TILDE = '~\\.paseo\\worktrees\\1qi0m53u\\chore-worktree-env-contract';
const HOME = 'C:\\Users\\dev';

test('the incident: git path and Paseo cwd are the same place', () => {
  // The old code did `t.path.toLowerCase() === a.cwd.toLowerCase()` - false for this pair.
  assert.notEqual(GIT.toLowerCase(), PASEO.toLowerCase());
  assert.equal(samePath(GIT, PASEO), true);
});

test('the real incident form: Paseo abbreviates home to ~, git does not', () => {
  // swarm-map already swapped backslashes; the ~ is what made === fail.
  assert.notEqual(PASEO_TILDE.replace(/\\/g, '/').toLowerCase(), GIT.toLowerCase());
  assert.equal(normalisePath(PASEO_TILDE, HOME), normalisePath(GIT, HOME));
  assert.equal(normalisePath('~', HOME), 'c:/users/dev');
  // a tilde that is not a home prefix is left alone
  assert.equal(normalisePath('C:/x/~tmp', HOME), 'c:/x/~tmp');
});

test('normalisePath handles separators, case, trailing slash, doubled slashes and MSYS drives', () => {
  const want = 'c:/users/dev/x';
  for (const p of ['C:\\Users\\dev\\x', 'c:/users/dev/x/', 'C:/Users//dev/x', '/c/Users/dev/x', '  C:\\Users\\dev\\x\\ ']) {
    assert.equal(normalisePath(p), want, p);
  }
  assert.equal(normalisePath('C:\\'), 'c:/');
  assert.equal(normalisePath(undefined), '');
});

test('empty or missing paths never match each other', () => {
  assert.equal(samePath('', ''), false);
  assert.equal(samePath(undefined, null), false);
});

test('an agent that cd-ed into a subfolder still owns the worktree; a sibling does not', () => {
  assert.equal(isPathInside(PASEO + '\\desktop-app', GIT), true);
  assert.equal(isPathInside(GIT + '-2', GIT), false);
  assert.equal(isPathInside('C:/Users/dev', GIT), false);
});

test('findAgentForWorktree finds the live agent across separator styles', () => {
  const agents = [{ id: 'a', cwd: 'D:\\code\\other' }, { id: 'luna', cwd: PASEO }, { id: 'nocwd' }, null];
  assert.equal(findAgentForWorktree(agents, GIT)?.id, 'luna');
  assert.equal(findAgentForWorktree(agents, 'C:/nowhere'), null);
  assert.equal(findAgentForWorktree(undefined, GIT), null);
});

const base = { isClean: true, hasOpenPr: false, agent: null, isProtected: false, agentsKnown: true, ageMs: OLD };

test('a clean, old, unattended, PR-less worktree is the ONLY prunable case', () => {
  assert.equal(pruneDecision(base).safe, true);
});

test('every single guard blocks the prune on its own', () => {
  const blockers = {
    dirty: { isClean: false },
    openPr: { hasOpenPr: true },
    protectedBranch: { isProtected: true },
    agentAttached: { agent: { id: 'luna' } },
    agentListFailed: { agentsKnown: false },
    ageUnknown: { ageMs: null },
    ageNaN: { ageMs: NaN },
    tooYoung: { ageMs: 60_000 },
  };
  for (const [name, over] of Object.entries(blockers)) {
    const d = pruneDecision({ ...base, ...over });
    assert.equal(d.safe, false, name);
    assert.ok(d.reason.length > 0, name);
  }
});

test('the incident, replayed end to end: fresh ticket worktree with a live agent is kept', () => {
  const agent = findAgentForWorktree([{ id: 'luna', cwd: PASEO }], GIT);
  const d = pruneDecision({ ...base, agent, ageMs: 4 * 60_000 });
  assert.equal(d.safe, false);
  assert.equal(d.reason, 'Agent attached');
});

test('even with the agent lookup broken, a fresh worktree survives on age alone', () => {
  const d = pruneDecision({ ...base, agent: null, ageMs: 4 * 60_000 });
  assert.equal(d.safe, false);
  assert.match(d.reason, /Younger than/);
});
