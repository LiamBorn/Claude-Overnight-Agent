---
name: stop
description: Stop the overnight run gracefully after the task in flight finishes, then write the morning report.
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(mkdir *), Bash(touch *), Bash(cat *), Bash(ls *)
---

Ask the run to stop.

The stop is graceful on purpose. The runner checks for the request before it starts each
task and while it is waiting out a usage limit. A task already in flight runs to the end,
gets verified, and gets committed if it passes, because killing it mid-edit would leave a
half-finished tree and waste the work already done.

Place the request:

```bash
mkdir -p "${CLAUDE_PROJECT_DIR}/.overnight" && \
  printf 'requested at %s\n' "$(date)" > "${CLAUDE_PROJECT_DIR}/.overnight/STOP"
```

Then show where things stand:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" --repo "${CLAUDE_PROJECT_DIR}"
```

Tell the user what will happen now: the current task finishes and is committed if it
passes review, the morning report is written to `.overnight/MORNING_REPORT.md`, and the
runner exits. If a task is mid-flight, say that it may take up to the per-task timeout.
Everything already committed stays on the branch regardless.

If the status shows no run in progress, say so plainly. The request file is harmless and
is cleared when a run ends, so there is nothing to undo.

Only if the user explicitly asks to kill it immediately rather than wait: the process id is
in `.overnight/runner.pid`. Tell them the command but warn them first that the task in
flight loses its work, because the runner will not get to save the patch or write the
report. Do not run it for them unless they say yes after hearing that.
