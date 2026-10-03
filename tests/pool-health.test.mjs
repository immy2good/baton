import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPools, poolOf, isPoolDead } from '../src/lib/pools.mjs';
import { loadRoster, resolveDispatch } from '../src/lib/roster.mjs';

/**
 * Issue #11: pool health must be an INPUT to the resolver.
 *
 * Example: OpenCode Go hits its monthly cap and resets on 2026-09-30. A
 * quota-dead agent does not error: it sits `running` forever with no pending
 * permission, so nothing downstream ever notices. Six of the sixteen roster
 * profiles are on that pool -- including `risk_default.low`, the writer for every
 * low-risk ticket, and `gate.cross_model[0]`.
 *
 * Fallback goes SIDEWAYS, never up. The chains are declared
 * and encoded in roster/routing.json -- this resolver walks them, it does not
 * invent its own.
 */

const CAPPED = new Date('2026-09-21T00:00:00Z');   // Go dead
const RECOVERED = new Date('2026-10-01T00:00:00Z'); // Go past dead_until

const roster = () => loadRoster({ snapshotPath: 'roster/profiles.json' });

test('the committed pools file records the Go outage -- the mechanism alone fixes nothing', () => {
  const pools = loadPools();
  assert.ok(pools['opencode-go'], 'opencode-go must be declared');
  assert.equal(pools['opencode-go'].dead_until, '2026-09-30');
  assert.match(pools['opencode-go'].reason, /cap/i);
});

test('poolOf matches a binding to its credit pool by data, not by guesswork', () => {
  const pools = loadPools();
  assert.equal(poolOf({ provider: 'opencode', model: 'opencode-go/deepseek-v4-pro' }, pools), 'opencode-go');
  assert.equal(poolOf({ provider: 'claude', model: 'claude-opus-5' }, pools), null,
    'an unmatched binding is healthy, never falsely dead');
});

test('a pool is dead only until its dead_until date', () => {
  const pools = loadPools();
  assert.equal(isPoolDead('opencode-go', pools, CAPPED), true);
  assert.equal(isPoolDead('opencode-go', pools, RECOVERED), false, 'the cap resets; the skip must too');
  assert.equal(isPoolDead(null, pools, CAPPED), false);
});

test('a low-risk ticket is NOT dispatched to the capped Go pool', () => {
  const d = resolveDispatch({
    domain: 'infrastructure', riskScore: 1, workType: 'implement',
    roster: roster(), now: CAPPED
  });
  assert.notEqual(d.writer.id, 'agent_profile_t2_implementer_deepseek_pro',
    'deepseek_pro is on opencode-go, capped until 2026-09-30');
  assert.equal(poolOf(d.writer.binding, loadPools()), null,
    'the resolved writer must be on a live pool');
  assert.equal(d.writer_fallback_from, 'agent_profile_t2_implementer_deepseek_pro',
    'the dispatch must say WHICH seat it stepped around');
});

test('the fallback goes sideways or down -- never up a tier', () => {
  const r = roster();
  const d = resolveDispatch({
    domain: 'infrastructure', riskScore: 1, workType: 'implement',
    roster: r, now: CAPPED
  });
  const rank = t => Number(String(t).replace('T', ''));
  const preferred = r.nodes.get('agent_profile_t2_implementer_deepseek_pro');
  assert.ok(rank(d.writer.tier) >= rank(preferred.tier),
    `fell UP from ${preferred.tier} to ${d.writer.tier}`);
});

test('a healthy pool is used as-is -- no gratuitous fallback', () => {
  const d = resolveDispatch({
    domain: 'infrastructure', riskScore: 1, workType: 'implement',
    roster: roster(), now: RECOVERED
  });
  assert.equal(d.writer.id, 'agent_profile_t2_implementer_deepseek_pro');
  assert.equal(d.writer_fallback_from, null);
});

test('the bulk seat steps around the capped pool too', () => {
  const d = resolveDispatch({
    domain: 'infrastructure', riskScore: 0, workType: 'bulk',
    roster: roster(), now: CAPPED
  });
  assert.equal(poolOf(d.writer.binding, loadPools()), null);
  assert.equal(d.writer_fallback_from, 'agent_profile_t4_bulk_deepseek_flash');
});

test('the cross-model reviewer is never drawn from a dead pool', () => {
  const d = resolveDispatch({
    domain: 'critical_systems', riskScore: 3, workType: 'implement',
    roster: roster(), now: CAPPED
  });
  assert.ok(d.cross_model_reviewer, 'risk 3 must still get a cross-model voice');
  assert.equal(poolOf(d.cross_model_reviewer.binding, loadPools()), null,
    'cross_model[0] (deepseek_plan) is on the capped pool');
});

/**
 * Policy: an unavailable model must NEVER block the work.
 * Out of credit, failed, capped, unreachable -- whatever the reason, the resolver
 * still hands back a seat. It may hand back a flagged one; it may not hand back
 * nothing. A blocked dispatch is indistinguishable from a lost one.
 */
test('when every candidate in a chain is dead the failsafe seat takes it -- never a block', () => {
  const r = roster();
  const everythingDead = {
    all: { provider: null, model_prefix: '', dead_until: '2099-01-01', reason: 'test' }
  };
  const d = resolveDispatch({
    domain: 'infrastructure', riskScore: 1, workType: 'implement',
    roster: r, now: CAPPED, pools: everythingDead
  });
  assert.ok(d.writer, 'an unavailable model must never leave the work unassigned');
  assert.ok(r.routing.gate.failsafe.includes(d.writer.id), d.writer.id);
  assert.equal(d.writer.tier, 'T2', 'a T2 preference takes the T2 failsafe, not a weaker one');
  assert.equal(d.failsafe_used, true);
  assert.equal(d.failsafe_forced, true, 'even the failsafe is dead here -- say so loudly, still dispatch');
  assert.match(d.failsafe_reason, /pool/i);
});

test('every failsafe seat is a real dispatchable writer, not a reviewer-only seat', () => {
  const r = roster();
  const ids = r.routing.gate.failsafe;
  assert.ok(Array.isArray(ids) && ids.length, 'routing.gate.failsafe must be a tier-ordered list');
  for (const id of ids) {
    const f = r.nodes.get(id);
    assert.ok(f, `routing.gate.failsafe names a profile that does not exist: ${id}`);
    assert.ok(f.roles.includes('writer'),
      `${id} cannot write, so the failsafe would block exactly when it is needed`);
  }
});

test('the failsafe never falls UP a tier -- a T4 bulk seat lands on a T4 failsafe', () => {
  const r = roster();
  const everythingDead = {
    all: { provider: null, model_prefix: '', dead_until: '2099-01-01', reason: 'test' }
  };
  const d = resolveDispatch({
    domain: 'infrastructure', riskScore: 0, workType: 'bulk',
    roster: r, now: CAPPED, pools: everythingDead
  });
  assert.equal(d.failsafe_used, true);
  assert.equal(d.writer.tier, 'T4',
    'never-up binds the failsafe too: a rename must not land on a T2 workhorse');
});

test('a normal dispatch is not marked as having used the failsafe', () => {
  const d = resolveDispatch({
    domain: 'critical_systems', riskScore: 1, workType: 'implement',
    roster: roster(), now: CAPPED
  });
  assert.equal(d.failsafe_used, false);
  assert.equal(d.failsafe_forced, false);
});

test('at the node cap the dispatch is marked at_capacity but STILL names its seat', () => {
  const r = roster();
  const cap = r.routing.max_active_nodes;
  assert.equal(cap, 4, 'the example policy caps active agents at 4');

  const busy = resolveDispatch({
    domain: 'infrastructure', riskScore: 1, workType: 'implement',
    roster: r, now: CAPPED, activeNodes: cap
  });
  assert.equal(busy.at_capacity, true, 'the caller must be told to queue');
  assert.ok(busy.writer, 'capacity is a queue signal, not a block -- the seat is still resolved');

  const free = resolveDispatch({
    domain: 'infrastructure', riskScore: 1, workType: 'implement',
    roster: r, now: CAPPED, activeNodes: cap - 1
  });
  assert.equal(free.at_capacity, false);
});
