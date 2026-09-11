# Overnight Agent

Write a plan during the day. Hand it off before bed. Wake up to committed, independently
verified work on a dedicated branch, and a report that tells you the truth about what
happened.

Your usage capacity sits idle for eight hours every night. The goal here is not to spend as
much of it as possible. The goal is to turn those hours into the largest amount of
**finished, verified, reviewable** work, which is a different target and leads to different
design decisions almost everywhere.

---

## The shape of it

```
/overnight:plan      →  an interview, then OVERNIGHT_PLAN.md
/overnight:validate  →  catches vague tasks, cycles, anything needing you awake
/overnight:start     →  preflight in front of you, then the run detaches
        …you sleep…
/overnight:status    →  progress, any time
/overnight:stop      →  finishes the task in flight, then stops
        …morning…    →  .overnight/MORNING_REPORT.md and a branch to review
```

## Install

```bash
claude plugin marketplace add LiamBorn/Claude-Overnight-Agent
claude plugin install overnight@overnight-agent
```

Then, in Claude Code, `/overnight:plan` is available. Requires Node 18 or newer, git, and a
`claude` on your PATH that is signed in. That last one matters: the run spawns headless
Claude Code sessions, and `claude -p` has to authenticate on its own. Check it with:

```bash
claude -p "reply with: ok" --max-turns 1
```

If that says "Not logged in", run `claude` once interactively and sign in. Preflight checks
this for you with `--probe` before every run, so you find out at bedtime rather than at 3am.

To develop against the plugin without installing it, pass `--plugin-dir` to `claude`, or just
call the scripts directly; the runner works standalone.

Installing from GitHub copies the plugin into a version-pinned directory under
`~/.claude/plugins/cache/`, so edits to a local clone do not affect the installed copy. To
develop against your own changes, add the clone as a second marketplace with
`claude plugin marketplace add /path/to/your/clone`; a local-path source loads straight from
that directory, so command and script edits take effect in the next session. Changes to
`hooks/hooks.json` or the agent files need `/reload-plugins` or a restart either way.

---

## How a run actually works

A run is an external Node process that invokes headless Claude Code **once per task**, and
supervises it from outside.

```
preflight → branch → for each task:
      fresh `claude -p` worker session
   →  the supervisor runs the acceptance commands itself
   →  a separate `claude -p` reviewer session judges the diff
   →  commit, or revert and retry
→ morning report
```

### Why a runner and not a Stop hook

The obvious alternative is a Stop hook that keeps one session alive until the plan is done.
It is fewer moving parts and it is the wrong answer, because it puts the agent in charge of
judging its own completion, its own budget and its own liveness.

| | External runner | Stop hook |
| --- | --- | --- |
| Context per task | Fresh process every time | Accumulates; compaction can lose the plan |
| A task crashes the process | Loop continues to the next task | The whole run dies |
| Usage limit | Runner sleeps, then resumes | The session *is* the thing being limited |
| Hard per-task timeout | SIGTERM from outside | No way to bound a turn |
| Who writes the state file | The supervisor | The supervised |

### Why the report can be trusted

A task is not done because the worker says it is. Verification is split in two, because the
two halves fail in different ways.

**The supervisor runs the acceptance commands itself**, on the real tree, and records the
exit codes. No model is involved, and the model never gets to report on its own test run. A
non-zero exit is a failure, full stop.

**Then a separate reviewer session judges the diff.** It sees the task, the changed files and
the acceptance results, but not the worker's reasoning. It answers what a command cannot: did
this achieve the goal, did it stay in scope, and was it obtained honestly. Before it runs, the
supervisor scans the diff mechanically for known shortcuts and hands over what it found:

- tests deleted, skipped, or emptied
- assertions weakened or made tautological
- the test runner's config, a CI workflow, or the npm script named in the criteria edited
- `@ts-ignore`, `# type: ignore`, `# noqa`, blanket `eslint-disable`
- files changed outside the declared scope

Only after both halves pass does the supervisor commit. **Workers never commit.** They are
denied every mutating git command, which is what lets the runner own history completely.

### When a task fails

The diff is saved to `.overnight/failed/<task>-attempt<n>.patch`, then the tree is reset to
that task's starting commit so a half-finished task cannot poison the next one. Nothing is
lost; apply the patch in the morning if you want to see it. Set `on_failure: keep` if you
would rather the mess stayed put.

The next attempt gets the previous failure and the reviewer's reasons as input, so it is not
starting blind. If three attempts fail with the **same** error fingerprint, the task is
declared stuck immediately rather than burning its remaining attempts, and tasks that
depend on it are skipped rather than failed.

### Usage limits

If a limit is hit, the runner logs it, waits, and resumes. It reads a reset time out of the
message when one is there, and otherwise backs off from five minutes, doubling to an hour.
**Waiting never costs a task an attempt**, because a limit is not the task's fault. If the
stop time passes while waiting, the run ends gracefully and still writes a report.

### Resuming

Everything needed to continue is in `.overnight/state.json`, written atomically. A run that
is killed, disconnected, or interrupted by a sleeping laptop picks up from where it stopped:
run `/overnight:start` again and it resumes rather than restarting. A task that was in flight
when the process died is requeued, and that attempt is counted, so a task that reliably kills
the runner cannot loop forever.

---

## The plan format

Plain Markdown, so a person can read it and other agents could consume it. Machine fields
live in fenced ```yaml blocks in a documented, restricted subset: scalars, lists, and lists
of one-level maps. Tabs, inline maps, and deeper nesting are **errors, not guesses** —
misreading a plan at 3am is worse than refusing to start.

```markdown
## Task: T1 — Support hours in parseDuration

```yaml
id: T1
priority: 1
depends_on: []
max_attempts: 2
scope:
  - src/parse-duration.js
acceptance:
  - command: node --test test/parse-duration.test.js
    expect: exit_zero
```

### Goal

Prose written for a reader with no conversation history, because that is exactly what the
worker will be.
```

`examples/OVERNIGHT_PLAN.example.md` is a realistic five-task plan for a TypeScript service.
`templates/OVERNIGHT_PLAN.template.md` is the annotated skeleton.

**`acceptance` is the heart of the format.** Each entry is a command and the exit status it
must produce. An entry with `check:` instead of `command:` is prose judged by the reviewer;
a task made only of those is rejected, because then "done" is only the model's opinion.

**The plan file is committed to the overnight branch** as its first commit, so the branch
carries the brief it was built from. If the plan was never committed on your own branch, it
will disappear from your working tree when you check that branch back out. Copy it first if
you want to keep it there.

---

## Configuration

Precedence, highest first: the plan's `## Settings` block, then `.overnight/config.json` in
the repo, then the plugin's userConfig, then the built-in defaults.

| Setting | Default | What it does |
| --- | --- | --- |
| `stop_at` | `"07:00"` | Local HH:MM the run must end by. Next occurrence. |
| `max_runtime_minutes` | `600` | Hard ceiling regardless of `stop_at`. |
| `max_tasks` | `20` | Stop after this many tasks reach a final state. |
| `max_consecutive_failures` | `3` | Abandon the run after this many failures in a row. |
| `task_timeout_minutes` | `45` | Wall-clock kill for one attempt. |
| `max_turns` | `120` | Agentic turn ceiling per session. |
| `model` / `reviewer_model` | `sonnet` | Models for workers and for the reviewer. |
| `baseline_command` | `null` | Run before the run; its exit code goes in the report. |
| `allow_package_install` | `false` | Per-task override available. |
| `allow_network` | `false` | Turns on WebFetch, WebSearch, curl and friends. |
| `on_failure` | `revert` | Or `keep` to leave the failed tree in place. |
| `stuck_threshold` | `3` | Identical errors before a task is declared stuck. |
| `limit_backoff_start_seconds` | `300` | First wait after a usage limit; doubles. |
| `limit_backoff_max_seconds` | `3600` | Ceiling on that wait. |
| `skip_review` | `false` | Turns off the gate. Don't. |
| `narrative_summary` | `true` | One labelled model-written paragraph at the report's end. |

Per task: `id`, `title`, `priority`, `depends_on`, `max_attempts`, `scope`, `acceptance`,
and `allow_package_install`.

---

## Safety model

The user is asleep. Everything below assumes that nobody will notice a mistake for eight
hours.

**Branch isolation.** All work happens on `overnight/<YYYY-MM-DD>`, created from a clean
tree. Nothing is ever pushed, merged, rebased, tagged, or force-pushed, and your mainline
branch is never checked out. Undoing an entire run is `git branch -D`.

**Two layers of permission, because one is not enough.** The first is a scoped allowlist
passed to every session with `--settings`. It permits test runners, type checkers, linters,
build tools and read-only git, and denies mutating git, `gh`, every publish and deploy CLI,
`sudo`, the network, package installs, and reads or writes of `.env` files, keys, `~/.ssh`,
`~/.aws` and credential stores. Secret paths are denied as `Read(...)` and `Edit(...)`, which
is the only form Claude Code actually consults for files.

The second layer exists because permission rules match the command text Claude writes and
are documented as **not** a boundary around a program: `Bash(git push *)` does not match
`git -C . push`, `sh -c 'git push'`, or `FOO=1 /usr/bin/git push`. A PreToolUse hook scans
the raw string for those spellings, checks that file writes stay inside the project, and
re-verifies before every Bash call that HEAD is still on the overnight branch. It fails
closed: if it cannot decide, it denies.

That hook is registered in every session where this plugin is installed, so **it exits
immediately unless `OVERNIGHT_RUN=1` is set**, which only the runner sets. Your ordinary
daytime sessions are completely unaffected, and there is a test that asserts exactly that.

**Nothing ever waits for you.** `--permission-prompts none` is passed when your Claude Code
build supports it (2.1.259+), and `AskUserQuestion` is denied outright. Anything unresolved
is denied and the worker is told to move on rather than retry. A question that genuinely
cannot be answered becomes a logged assumption or a skipped task, and lands in the report.

**Bounded in every dimension.** Stop time, maximum runtime, maximum tasks, consecutive
failures, per-attempt wall clock, per-session turns, and per-task attempts. A run cannot
quietly continue into your working day.

### Bypass mode

You can pass your own `--settings` with `bypassPermissions` if you want to. If you do,
**run it inside a container or a devcontainer.** Without the allowlist and the hook, an
unattended agent has your shell for eight hours with nobody watching, and the blast radius
is your whole machine rather than one git branch. There is no configuration option for this
on purpose; you have to go out of your way.

### macOS and sleep

Closing a MacBook lid sleeps the machine. `caffeinate`, which `/overnight:start` uses, stops
*idle* sleep but not a closed lid unless the machine is on power with an external display.
The run pauses when the machine sleeps and continues on wake, because all state is on disk,
but it may wake past its stop time and stop there. Leave the lid open, or use a machine that
stays awake.

---

## What is written where

Everything lives in `.overnight/`, which the runner adds to `.git/info/exclude` so it never
reaches a commit and never touches your `.gitignore`.

| Path | What it is |
| --- | --- |
| `MORNING_REPORT.md` | The report. Read this first. |
| `state.json` | Resumable run state, written atomically. |
| `log.md` | Timestamped log of every decision. |
| `failed/*.patch` | Work from failed attempts, kept. |
| `transcripts/*.json` | Raw session output, for when something is odd. |
| `runner.out` | stdout and stderr of the runner process. |
| `runner.pid`, `STOP` | Liveness and the stop request. |
| `worker-settings.json` | The exact permission set used, so you can audit it. |

---

## Testing

```bash
node scripts/selftest.mjs
```

135 checks. The unit half covers the parser, the validator, result classification, error
fingerprinting, shortcut detection and state handling. The integration half drives the real
runner against `testing/fake-claude.mjs`, a deterministic stand-in, through the paths that
only matter when something goes wrong: a reviewer rejection followed by a successful retry,
three identical errors blocking a task and skipping its dependents, a usage limit pausing and
resuming without spending an attempt, a worker process dying, a stop request, resuming an
interrupted run, and a dry run that changes nothing. None of those can be produced on demand
from the real CLI, which is why the stub exists.

`sample-repo/` at the repository root is a fixture with genuine defects and a plan that fixes
them, for trying the whole thing end to end.

---

## Troubleshooting

**The run stopped immediately.** Read `.overnight/runner.out`. Nearly always a plan that does
not validate, a dirty working tree, or `claude -p` not being signed in.

**"Not logged in" in the log.** The headless CLI authenticates separately from any GUI. Run
`claude` interactively once. Note that the desktop app holds its session in-process and does
not hand it to child processes, so a runner launched from inside the desktop app may not
authenticate even when the app itself is signed in. Launch from a terminal.

**Everything failed with "Blocked by the overnight guard".** The guard is doing its job, and
the reason is in the report. If a task genuinely needs the network or a package install, set
`allow_network` or `allow_package_install` in the plan rather than disabling the guard.

**Tasks fail on a command that works for you.** Acceptance commands run from the repository
root with `CI=1` and no colour. Anything depending on your shell aliases, your `nvm` default,
or a virtualenv you activate by hand will not be there. Use a command that works from a
fresh shell.

**It says a task is blocked after three attempts.** Three identical errors means retrying is
not working. The saved patches and transcripts in `.overnight/` show what it tried.

**The status says "NOT running" but nothing finished.** The process died without writing a
report. Run `/overnight:start` again to resume from saved state.

**The plan file vanished when I switched branches.** It is committed on the overnight branch,
which is where its provenance belongs. `git show <branch>:OVERNIGHT_PLAN.md` gets it back.

**I want to see what it would do first.** `/overnight:start --dry-run` walks the whole plan,
touches nothing, and never calls the model.
