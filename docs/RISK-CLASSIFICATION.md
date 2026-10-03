# Risk Classification

Risk sets the minimum evidence, reviewers and human boundaries before a task can be marked done.

| Level | Typical scope | Minimum verification and review |
|---|---|---|
| **LOW** | Docs, comments, local helper scripts with no contract impact. | Local build/test; self-inspection; fast review optional. |
| **MEDIUM** | Isolated product code, small features, reversible bugfixes in one repo. | Fast review by a different family and harness; tests pass, with a negative control where it applies. |
| **HIGH** | Money movement, auth or licensing, cross-repo contracts, customer-visible state, database migrations. | **Apex Review mandatory** for work authored below T0. Work authored by a T0 model goes through the two-axis review and verified tests instead (frontier does not review frontier). Sign-off bound to the reviewed commit SHA. Regression tests plus negative control. |
| **CRITICAL** | Production writes and deploys, live CMS updates, signing keys, licence issuance, real-money accounts. | **Human-held boundary.** The agent prepares and verifies the release up to the boundary, writes a tested rollback plan, and stops for a human to execute. |

## Rules
1. **Unknown is never LOW.** If risk is unclear or touches a shared boundary, treat it as HIGH until shown otherwise.
2. **Risk only ratchets up.** If a simple fix turns out to touch a critical path, update the checkpoint and require the higher review tier before completion.
3. **Singletons versus test environments:** production deploys, live CMS writes, signing keys and licence issuance are human-held. Sandboxes, emulators and demo accounts are agent-allocatable.
