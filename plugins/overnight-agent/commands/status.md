---
name: status
description: Show progress of the overnight run — what is done, what is running, what failed, and when it will stop.
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(git log *)
---

Current state of the overnight run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" --repo "${CLAUDE_PROJECT_DIR}"`

Relay that to the user in a few lines. Lead with whether it is still running and how far
through it is, then anything that needs their attention.

Things worth calling out rather than leaving in the dump:

- The run is **not running** but was never marked finished. The process died. Tell them
  they can pick it up with `/overnight:start`, which resumes from the saved state.
- A task is **blocked**. It will not be retried, and anything depending on it is skipped.
  Say which one and why.
- The run is **paused on a usage limit**. Say when it expects to resume. This is normal
  and needs nothing from them.
- Several tasks failed in a row. The run stops on its own after the configured limit.

If no run has been started, say so and point at `/overnight:plan`. Keep it short either
way; this command is for glancing at.
