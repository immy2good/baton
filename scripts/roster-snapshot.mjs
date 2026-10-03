#!/usr/bin/env node
/**
 * Paseo users only: copy the live Paseo agent profiles into roster/profiles.json.
 *
 * roster/profiles.json is what baton reads on machines without Paseo (CI, a fresh
 * worktree, a teammate). Run this after adding or editing a profile in Paseo, then
 * commit the diff -- roster.mjs throws if routing names a profile that neither the
 * live config nor the file has.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfiles, BINDING_FIELDS } from '../src/lib/roster.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/roster-snapshot.mjs   (Paseo users: overwrites roster/profiles.json with the live Paseo profiles)');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'roster', 'profiles.json');

const { profiles, source } = loadProfiles({ env: { ...process.env, BATON_LAUNCHER: 'paseo' } });
if (source !== 'paseo') {
  console.error('No live Paseo profiles found; refusing to overwrite roster/profiles.json with itself.');
  process.exit(1);
}

const payload = {
  $comment:
    "Agent profiles: the runtime binding for each seat (provider, model, mode, thinking level). " +
    "Copied from Paseo's daemon.agentProfiles by scripts/roster-snapshot.mjs.",
  profiles: profiles.map(p =>
    Object.fromEntries(
      ['id', 'name', ...BINDING_FIELDS, 'featureValues']
        .filter(f => p[f] !== undefined)
        .map(f => [f, p[f]])
    )
  )
};

writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`Wrote ${payload.profiles.length} profiles to ${OUT}`);
