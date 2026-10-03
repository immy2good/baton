#!/usr/bin/env node
/**
 * Register agents with baton's default `files` launcher.
 *
 *   node scripts/agents.mjs register --id claude-1 --provider claude [--status running] [--cwd <path>]
 *   node scripts/agents.mjs done --id claude-1
 *   node scripts/agents.mjs list [--json]
 *
 * Call `register` when an agent starts (and again to refresh its heartbeat or
 * status), and `done` when it stops. A harness hook is the natural place for both.
 * Not needed when Paseo is the launcher: baton reads `paseo ls` instead.
 */
import { parseArgs } from 'node:util';
import { listAgents, registerAgent, unregisterAgent, resolveLauncherName } from '../src/lib/launcher.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    name: { type: 'string' },
    provider: { type: 'string', default: '' },
    status: { type: 'string', default: 'running' },
    cwd: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
});

const cmd = values.help ? undefined : positionals[0];
try {
  if (cmd === 'register') {
    const rec = registerAgent({ id: values.id, name: values.name, provider: values.provider, status: values.status, cwd: values.cwd || process.cwd() });
    console.log(`registered ${rec.id} (${rec.status}) at ${rec.cwd}`);
  } else if (cmd === 'done') {
    unregisterAgent({ id: values.id });
    console.log(`removed ${values.id}`);
  } else if (cmd === 'list') {
    const res = listAgents();
    if (values.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok) {
      console.log(`launcher ${res.launcher}: cannot list agents (${res.reason})`);
      process.exitCode = 1;
    } else {
      console.log(`launcher ${res.launcher}: ${res.value.length} agent(s)`);
      for (const a of res.value) console.log(`  ${a.fullId.padEnd(20)} ${a.status.padEnd(8)} ${a.provider.padEnd(10)} ${a.cwd}`);
    }
  } else {
    console.log(`usage: agents.mjs register|done|list   (launcher: ${resolveLauncherName()})`);
    process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
