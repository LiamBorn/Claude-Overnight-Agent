---
name: start
description: Run preflight checks, then launch the overnight run in the background. Pass --dry-run to walk the plan without changing anything.
argument-hint: "[--dry-run]"
disable-model-invocation: true
allowed-tools: Read, Bash(node *), Bash(git status *), Bash(git log *), Bash(git branch *), Bash(nohup *), Bash(caffeinate *), Bash(sh *), Bash(cat *), Bash(which *)
---

Start the overnight run. The user is about to go to bed, so anything that is going to fail
must fail here, in front of them, not at 3am.

Arguments: $ARGUMENTS

## If they passed --dry-run

Run this and show them the result. It creates no branch, makes no commit, changes no file,
and never calls the model:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" --repo "${CLAUDE_PROJECT_DIR}" --dry-run
```

Summarize what it would do in a few lines, point out anything that looks wrong, and stop.
Do not start a real run in the same turn.

## Otherwise: preflight first

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --repo "${CLAUDE_PROJECT_DIR}" --probe --baseline --json
```

Read the JSON. Show the user a short readable summary, not the raw output.

**If `ok` is false, stop.** Explain each failing check in one line with its suggested fix.
Do not launch anything. Offer to fix what you can fix.

If `ok` is true, still surface the warnings that matter to them tonight:

- On macOS, say plainly that closing the lid sleeps the machine. `caffeinate` stops idle
  sleep but not a closed lid, unless the machine is on power with an external display.
  The run pauses when the machine sleeps and picks up where it left off on wake, but it
  may wake past its stop time and stop. Leaving the lid open is the reliable option.
- If a previous run was interrupted, say that this will resume it rather than start fresh.
- If the baseline command already exits non-zero, tell them, because some failures in the
  morning report will not be the run's fault.

Then tell them, in one or two lines each: which branch will be created, how many tasks, what
time it will stop, and that nothing will be pushed or merged.

## Launching

Launch detached so it survives this session ending and the terminal closing. Include
`--resume` when preflight reported an interrupted previous run, and
`--permission-prompts-supported` when preflight reported that flag is available.

```bash
cd "${CLAUDE_PROJECT_DIR}" && \
  mkdir -p .overnight && \
  nohup sh -c 'exec caffeinate -dimsu node "$0" --repo "$1" > .overnight/runner.out 2>&1' \
    "${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs" "${CLAUDE_PROJECT_DIR}" \
    > /dev/null 2>&1 &
```

On a machine without `caffeinate`, drop that word from the command. Add any extra runner
flags after `"${CLAUDE_PROJECT_DIR}"`.

Wait a couple of seconds, then confirm it actually started:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" --repo "${CLAUDE_PROJECT_DIR}"
```

If the status shows no run or the process is already gone, read `.overnight/runner.out`
and tell the user what went wrong. A run that dies in the first five seconds is almost
always a bad plan path or a permissions problem, and it is far better to catch it now.

## Signing off

Close with what they need and nothing more: the branch name, the stop time, that
`/overnight:status` shows progress and `/overnight:stop` ends it cleanly after the current
task, and that the morning report will be at `.overnight/MORNING_REPORT.md`.
