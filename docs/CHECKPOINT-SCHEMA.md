# Checkpoint Schema

The authoritative schema is [`schemas/checkpoint.schema.json`](schemas/checkpoint.schema.json).

Write `checkpoint.json` in the worktree root **every loop**, including loops with no progress. A successor agent must be able to resume using only the issue, the worktree and `checkpoint.json`, without the previous agent's chat.

## Version 1 fields

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | Yes | Integer `1`. |
| `ticket` | Yes | Assigned issue reference. |
| `node` | Yes | One of `cursor`, `claude`, `opencode`, `antigravity`, `codex`, `perplexity`, `other`. |
| `repo` | Yes | Owning repository name. |
| `branch` | Yes | Worktree branch name. |
| `goal` | Yes | Concrete assigned outcome. |
| `updated_at` | Yes | RFC 3339 timestamp (e.g. `2026-09-19T22:00:00Z`). |
| `files` | No | Relative paths touched or relevant. |
| `proven` | Yes | Verified checks with concrete results. |
| `blocked` | Yes | Concrete blockers; `[]` when none. |
| `next` | Yes | The exact next step, or the stop/handoff action. |
| `commit` | No | Relevant commit SHA, when one exists. |

## Example

```json
{
  "schema_version": 1,
  "ticket": "https://github.com/acme/web-app/issues/123",
  "node": "claude",
  "repo": "web-app",
  "branch": "agent/claude/fix-session-timeout",
  "goal": "Fix session timeout regression after login",
  "updated_at": "2026-09-19T22:00:00Z",
  "files": ["src/session.ts", "tests/session.test.ts"],
  "proven": ["npm test: 212 passed; new timeout test fails without the fix"],
  "blocked": [],
  "next": "Ask the reviewer seat to check out the WIP branch",
  "commit": "a1b2c3d4e5f6"
}
```
