# Launchers

baton never starts agents. It only needs to know **which agents are running and in which folder**, for two things:

- the **active-agent cap** (`routing.max_active_nodes`): over the cap, a dispatch is marked `at_capacity` so you queue it;
- the **prune guard**: a worktree with an agent in it is never deleted.

That knowledge comes from a launcher, chosen in [`src/lib/launcher.mjs`](../src/lib/launcher.mjs).

| Launcher | When | How agents are found |
|---|---|---|
| `files` (default) | Anything: terminals, IDEs, scripts | Each agent writes `$BATON_HOME/agents/<id>.json` (default `~/.baton/agents/`) |
| `paseo` | Automatically when `~/.paseo` exists | `paseo ls --json` |

Force one with `BATON_LAUNCHER=files` or `BATON_LAUNCHER=paseo`.

## The `files` launcher

Register an agent when it starts and remove it when it stops:

```bash
node scripts/agents.mjs register --id codex-2 --provider codex --cwd /path/to/worktree
node scripts/agents.mjs register --id codex-2 --status idle   # update status / heartbeat
node scripts/agents.mjs done --id codex-2
```

A harness hook is the natural place for these calls. An active agent that has not re-registered for 30 minutes is reported as `stale`: it no longer counts toward the cap, but its worktree is still protected from pruning.

## "Cannot see" is not "nothing running"

Every launcher returns `{ ok: true, value: [...] }` or `{ ok: false, reason }`. `ok: false` means the agents could not be read, and callers treat it as unknown: the capacity count is `null` rather than `0`, and nothing is pruned.

## Adding a launcher

Write a function that returns the shape above, with each agent normalised to `{ id, fullId, name, provider, status, cwd, created }`, add it to `LAUNCHERS` in `src/lib/launcher.mjs`, and add a test next to [`tests/capacity.test.mjs`](../tests/capacity.test.mjs).
