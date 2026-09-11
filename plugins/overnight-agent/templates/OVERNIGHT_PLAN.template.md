# Overnight plan

<!-- overnight-plan-format: 1 -->
<!--
  This file is plain Markdown on purpose. A person reads it before bed, and a machine
  reads the fenced yaml blocks. Any agent that can read Markdown can consume this format.

  The yaml blocks use a deliberately restricted subset:
      key: scalar            strings, numbers, true/false, null
      key: []                empty inline list
      key: [a, b]            inline list of scalars
      key:                   block list
        - item
      key:                   block list of one-level maps
        - subkey: value
          other: value
  Tabs, inline maps, and deeper nesting are errors, not guesses. Run /overnight:validate.
-->

## Settings

```yaml
# When the run must stop, as local 24-hour HH:MM. The next occurrence is used.
stop_at: "07:00"
# Hard ceiling on run length, whatever stop_at says.
max_runtime_minutes: 600
# Stop after this many tasks reach a final state.
max_tasks: 20
# Give up on the whole run after this many failures in a row.
max_consecutive_failures: 3
# Hard wall-clock kill for one attempt at one task.
task_timeout_minutes: 45
# Model for the workers, and for the independent reviewer.
model: sonnet
reviewer_model: sonnet
# Run this before the run starts and record its exit code, so the morning report can
# tell your pre-existing failures from ones the run introduced. Optional but recommended.
baseline_command: null
# Off by default. Turn either on only if a task genuinely cannot be done without it.
allow_package_install: false
allow_network: false
# After a task uses up its attempts: "revert" to its starting commit (the work is still
# saved as a patch), or "keep" the half-finished tree.
on_failure: revert
```

## Task: T1 — A short title naming one outcome

```yaml
id: T1
# Lower numbers run first among tasks whose dependencies are met.
priority: 1
# Task ids that must be DONE before this one starts.
depends_on: []
# Retries before the task is marked failed. Three identical errors blocks it sooner.
max_attempts: 2
# Files and directories this task owns. Anything changed outside these is flagged to
# the reviewer, so keep it honest rather than broad.
scope:
  - src/some/file.ts
  - src/some/__tests__/
# The only definition of "done". Each entry is a command and the exit status it must
# produce. Prose here is not enough; a command a shell can run is what makes the
# morning report trustworthy.
acceptance:
  - command: npm test -- src/some
    expect: exit_zero
  - command: npx tsc --noEmit
    expect: exit_zero
```

### Goal

Write what you would tell a competent colleague who has never seen this codebase and
cannot ask you anything. Say what outcome you want and why it matters. Name the specific
behaviour that should change. If there is a decision you would normally be consulted on,
make it here and write it down, because nobody will be awake to make it later.

### Notes

Optional. Constraints, the approach you want taken, files worth reading first, things that
look relevant but are not. If there is an obvious wrong way to do this, say so here.
