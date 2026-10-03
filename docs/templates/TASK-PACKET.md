# Task Packet Template

Two tiers: the human writes four fields; the agent fills in the rest during preflight.

---

## Tier 1: Dispatcher Brief (human input)

```markdown
### Dispatch Brief
- **Issue:** <link to the assigned issue in the owning repo>
- **Objective and done criteria:** <1-2 sentence definition of done>
- **Risk:** <LOW | MEDIUM | HIGH | CRITICAL>
- **Forbidden boundaries:** <human-held boundaries, e.g. no production deploys, no live CMS writes>
```

---

## Tier 2: Runtime Binding (agent preflight output)

During preflight step 3 the agent records its binding in `checkpoint.json` and on the issue:

```markdown
### Runtime Binding
- **Harness:** <claude | codex | cursor | opencode | antigravity | other>
- **Launcher session:** <ID from the launcher, if any>
- **Repository:** <name and git remote>
- **Worktree path:** <absolute path>
- **Branch and base commit:** <branch> @ <commit SHA>
- **Author model:** <model id; a T0 author waives Apex Review>
- **Review strategy:** <Fast review (different family) | Apex Review (author below T0) | Two-axis review + verified tests (T0 author)>
- **Checkpoint:** <path to checkpoint.json>
```
