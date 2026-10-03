import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countActiveNodes, ACTIVE_STATUSES } from '../src/lib/capacity.mjs';

/**
 * The count is the input that makes the max-active-agents cap real. Without it
 * the cap is a parameter nothing passes, so `at_capacity` is false in every
 * production path -- a restriction that restricts nothing.
 */

const fakePaseo = rows => () => JSON.stringify(rows);
const paseo = exec => countActiveNodes({ launcher: 'paseo', exec });

test('only working statuses hold capacity -- idle agents do not', () => {
  const n = paseo(fakePaseo([
    { status: 'running' },
    { status: 'idle' },
    { status: 'idle' },
    { status: 'working' }
  ]));
  assert.equal(n, 2);
});

test('status matching is case-insensitive and reads lastStatus as well', () => {
  assert.equal(paseo(fakePaseo([{ status: 'RUNNING' }, { lastStatus: 'Busy' }])), 2);
});

test('an unreachable launcher returns null, NOT zero', () => {
  const n = paseo(() => { throw new Error('daemon unreachable'); });
  assert.equal(n, null,
    '0 would claim nothing is running when we simply cannot see it, letting unlimited dispatches through exactly when nobody is watching');
});

test('a launcher error payload is also null, not an empty count', () => {
  assert.equal(paseo(() => JSON.stringify({ error: { code: 'ECONNREFUSED' } })), null);
});

test('an empty list of agents is a real zero', () => {
  assert.equal(paseo(fakePaseo([])), 0);
});

test('the files launcher counts registered agents and ignores stale ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baton-cap-'));
  const now = Date.now();
  const rec = (id, status, ageMs) => writeFileSync(join(dir, `${id}.json`),
    JSON.stringify({ id, status, cwd: '/w/' + id, updatedAt: new Date(now - ageMs).toISOString() }));
  rec('a', 'running', 1000);
  rec('b', 'idle', 1000);
  rec('c', 'running', 2 * 60 * 60 * 1000); // stopped checking in two hours ago
  assert.equal(countActiveNodes({ launcher: 'files', dir, now }), 1);
});

test('the files launcher with no folder yet is a real zero', () => {
  assert.equal(countActiveNodes({ launcher: 'files', dir: join(tmpdir(), 'baton-missing-' + Date.now()) }), 0);
});

test('the active statuses are a named list, not scattered string literals', () => {
  assert.ok(ACTIVE_STATUSES.includes('running'));
  assert.ok(!ACTIVE_STATUSES.includes('idle'));
});
