import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRoster,
  formatReviewDiamond,
  loadProfiles,
  resolveWriter,
  resolveReviewers,
  resolveDispatch,
  writerCandidates,
  resolveLegacyId
} from '../src/lib/roster.mjs';

// Every test resolves against the committed roster/profiles.json, never the machine's
// live launcher config -- a test that passes only on one laptop is not a gate.
const roster = loadRoster({ configPath: '/nonexistent-paseo-config.json' });

const DOMAINS = ['critical_systems', 'auth_security', 'web_ui', 'infrastructure', 'something_unclassified'];
const RISKS = [0, 0.5, 1, 1.51, 2, 2.9, 3];

test('the profiles file is the fallback when no live Paseo config exists', () => {
  const { source, profiles } = loadProfiles({ configPath: '/nonexistent-paseo-config.json' });
  assert.equal(source, 'file');
  assert.ok(profiles.length >= 16, `expected the full profile set, got ${profiles.length}`);
  assert.equal(roster.source, 'file');
});

test('every routed profile resolves to a real profile with a runtime binding', () => {
  for (const node of roster.nodes.values()) {
    assert.ok(node.binding.provider, `${node.id} has no provider`);
    assert.ok(node.binding.model, `${node.id} has no model`);
    assert.ok(node.tier, `${node.id} has no tier`);
    assert.ok(node.family, `${node.id} has no family`);
  }
});

// The defect this whole module exists for.
test('critical-systems work goes to its domain primary, never to apex', () => {
  const w = resolveWriter(roster, { domain: 'critical_systems', riskScore: 1.51 });
  assert.equal(w.id, 'agent_profile_t2_implementer_opus_medium');
  assert.equal(w.binding.model, 'claude-opus-5');
  assert.equal(w.binding.thinkingOptionId, 'medium');
});

test('apex is never a writer, for any domain at any risk', () => {
  const apexId = roster.routing.gate.apex;
  for (const domain of DOMAINS) {
    for (const riskScore of RISKS) {
      for (const workType of ['implement', 'docs', 'research', 'bulk']) {
        const w = resolveWriter(roster, { domain, riskScore, workType });
        assert.notEqual(w.id, apexId, `${domain} @ risk ${riskScore} (${workType}) resolved to apex`);
      }
    }
  }
  assert.ok(!writerCandidates(roster).some(n => n.id === apexId));
});

test('apex holds no writer role in the routing policy', () => {
  assert.ok(!roster.routing.profiles[roster.routing.gate.apex].roles.includes('writer'));
});

test('risk default: risk <= 1 goes to Go, risk >= 2 goes to Sol medium', () => {
  // `infrastructure` has no domain primary, so the risk band decides.
  assert.equal(
    resolveWriter(roster, { domain: 'infrastructure', riskScore: 0.5 }).id,
    'agent_profile_t2_implementer_deepseek_pro'
  );
  assert.equal(
    resolveWriter(roster, { domain: 'infrastructure', riskScore: 2.4 }).id,
    'agent_profile_t2_implementer_sol_medium'
  );
});

test('bulk and research never reach a flagship implementer', () => {
  assert.equal(
    resolveWriter(roster, { domain: 'critical_systems', riskScore: 3, workType: 'bulk' }).tier,
    'T4'
  );
  assert.equal(
    resolveWriter(roster, { domain: 'auth_security', riskScore: 3, workType: 'research' }).id,
    'agent_profile_t3_research_pplx'
  );
});

test('reviewer is always a different family from the writer', () => {
  for (const domain of DOMAINS) {
    for (const riskScore of RISKS) {
      for (const requiresApex of [true, false]) {
        const d = resolveDispatch({ domain, riskScore, requiresApex, roster });
        assert.notEqual(
          d.reviewer.family,
          d.writer.family,
          `${domain} @ ${riskScore} apex=${requiresApex}: ${d.writer.id} reviewed by same family`
        );
        assert.equal(d.family_split_valid, true);
      }
    }
  }
});

test('a GPT writer is never reviewed by Astra (same family)', () => {
  const sol = roster.nodes.get('agent_profile_t2_implementer_sol_medium');
  const { reviewer } = resolveReviewers(roster, { writer: sol, requiresApex: true, riskScore: 3 });
  assert.notEqual(reviewer.id, roster.routing.gate.apex);
  assert.equal(reviewer.id, roster.routing.gate.two_axis);
});

test('a below-T0 non-GPT writer with apex required gets Astra', () => {
  const opus = roster.nodes.get('agent_profile_t2_implementer_opus_medium');
  const { reviewer } = resolveReviewers(roster, { writer: opus, requiresApex: true, riskScore: 3 });
  assert.equal(reviewer.id, roster.routing.gate.apex);
});

test('an explicit T0 author waives apex review (frontier does not review frontier)', () => {
  const d = resolveDispatch({
    domain: 'critical_systems',
    riskScore: 3,
    requiresApex: true,
    author: 'claude-fable-5-1',
    roster
  });
  assert.equal(d.requires_apex_review, false);
  assert.equal(d.apex_waived, true);
  assert.match(d.apex_waived_reason, /frontier does not review frontier/);
});

test('with no author stated, apex review is not waived (fails closed)', () => {
  const d = resolveDispatch({ domain: 'critical_systems', riskScore: 3, requiresApex: true, roster });
  assert.equal(d.requires_apex_review, true);
  assert.equal(d.apex_waived, false);
  assert.equal(d.effective_author, 'claude-opus-5');
});

test('risk >= threshold adds a cross-model voice from a third family', () => {
  const d = resolveDispatch({ domain: 'critical_systems', riskScore: 2.5, roster });
  assert.ok(d.cross_model_reviewer, 'expected a cross-model reviewer at risk 2.5');
  assert.notEqual(d.cross_model_reviewer.family, d.writer.family);
  assert.notEqual(d.cross_model_reviewer.family, d.reviewer.family);
});

test('low risk does not spend a cross-model seat', () => {
  assert.equal(resolveDispatch({ domain: 'critical_systems', riskScore: 0.5, roster }).cross_model_reviewer, null);
});

test('the dispatch carries the runtime binding, including effort', () => {
  const d = resolveDispatch({ domain: 'critical_systems', riskScore: 1.51, roster });
  assert.ok(d.writer.binding.provider && d.writer.binding.model && d.writer.binding.modeId);
  assert.equal(d.writer.binding.thinkingOptionId, 'medium');
  assert.ok(d.reviewer.binding.provider && d.reviewer.binding.model);
});

test('retired four-seat ids still resolve for old receipts', () => {
  assert.equal(resolveLegacyId(roster, 'apex').id, roster.routing.gate.apex);
  assert.equal(resolveLegacyId(roster, 'orchestrator').id, roster.routing.gate.two_axis);
  assert.equal(resolveLegacyId(roster, 'not_a_seat'), null);
});

test('routing that names a profile the roster does not have fails loudly', () => {
  assert.throws(
    () => loadRoster({
      configPath: '/nonexistent-paseo-config.json',
      routingPath: new URL('./fixtures/roster-routing.unknown-profile.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    }),
    /absent from the file profiles/
  );
});

// The finding that mattered: requirement 1 was asserted in a comment and covered by
// tests, but nothing in the resolver rejected an apex writer. These pin the guard.
const fixture = name =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('routing that points a work seat at the apex profile is refused at load', () => {
  assert.throws(
    () => loadRoster({
      configPath: '/nonexistent-paseo-config.json',
      routingPath: fixture('roster-routing.apex-as-writer.json')
    }),
    /cannot be dispatched as workers.*agent_profile_t0_apex_reviewer_astra/s
  );
});

test('resolveWriter itself refuses a seat that cannot be dispatched', () => {
  // Hand-build a roster that bypassed loadRoster's check, to prove the second belt.
  const rogue = {
    routing: {
      ...roster.routing,
      work_type_primary: {},
      domain_primary: { critical_systems: roster.routing.gate.apex },
      risk_default: roster.routing.risk_default
    },
    nodes: roster.nodes,
    source: 'test'
  };
  assert.throws(
    () => resolveWriter(rogue, { domain: 'critical_systems', riskScore: 1 }),
    /cannot be dispatched as a worker/
  );
});

test('both CLIs share one review_diamond shape, binding included', () => {
  const d = resolveDispatch({ domain: 'critical_systems', riskScore: 2.5, roster });
  const shaped = formatReviewDiamond(d);
  assert.deepEqual(Object.keys(shaped).sort(), [
    'cross_model_reviewer', 'family_split_valid', 'gate', 'reviewer',
    'reviewer_binding', 'reviewer_reason', 'writer', 'writer_binding', 'writer_tier'
  ]);
  assert.equal(shaped.writer_binding.thinkingOptionId, 'medium');
});
