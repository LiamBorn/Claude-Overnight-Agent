---
name: plan
description: Interview the user about what they want done overnight and write OVERNIGHT_PLAN.md.
argument-hint: "[what you want done tonight]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(git log *), Bash(git status *), Bash(ls *), Bash(cat *), Bash(npm run *), Bash(node *)
---

Write an overnight plan with the user. They are awake now and will not be later, so every
decision has to be made in this conversation.

What they want done tonight: $ARGUMENTS

## The template this must produce

!`cat "${CLAUDE_PLUGIN_ROOT}/templates/OVERNIGHT_PLAN.template.md"`

## Repository context

Current branch and recent history:

!`git log --oneline -8 2>/dev/null || echo "not a git repository"`

!`git status --short 2>/dev/null | head -20`

## How to run this session

Start by understanding the codebase well enough to write acceptance criteria that will
actually run. Look at how tests are invoked here, whether there is a type checker or
linter, and what the existing test layout looks like. A plan whose commands do not exist
is worse than no plan, because it fails at 2am instead of now.

Then interview the user. Do not write the plan from a one-line request. Ask about what you
genuinely cannot determine from the code, a few questions at a time rather than one long
interrogation. The things worth asking about:

- **What outcome do they actually want**, as opposed to which files they imagine changing.
- **How each task will be proven done.** Push on this. "The tests pass" is not enough if
  you do not know which command runs them. Keep asking until each task has a command and an
  expected exit status. If something genuinely cannot be checked by a command, say so, and
  either drop it or make it a smaller task that can be.
- **Decisions they would normally want to be asked about.** Naming, whether to refactor
  adjacent code, which of two approaches, how far to take something. Every one of these
  either gets decided now and written into the goal, or gets guessed at while they sleep.
- **What is off limits.** Files not to touch, patterns not to introduce, work that looks
  adjacent but should be left alone.
- **What order things have to happen in**, and which tasks are genuinely independent.

Use AskUserQuestion when there are a few concrete options. Use plain questions when the
answer is open-ended.

## Writing the plan

Aim for tasks that one fresh session can finish. As a rule of thumb, if a task needs more
than a handful of files changed or has more than three or four acceptance commands, split
it. A large task that fails costs the whole night; two small ones cost half of it. Order
them so the most valuable work happens first, since the run may stop early.

For each task, the goal section carries the intent. Write it for a reader with no
conversation history, because that is exactly what the worker will be. Include the decisions
you extracted above, in plain words. If you know the wrong way to do it, say so.

Set `scope` honestly: the files and directories the task really owns. It is used to detect
work drifting somewhere unexpected, so a scope of the whole repo tells nobody anything.

Set `baseline_command` in settings to whatever the user runs to check the project is
healthy. If it is already failing tonight, the morning report will say so rather than
blaming the run.

## Finishing

Write the plan to `OVERNIGHT_PLAN.md` in the repository root. Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" --repo "${CLAUDE_PROJECT_DIR}"
```

Fix anything it reports and run it again until it is clean. Then show the user a short
summary: how many tasks, what order they run in, roughly what each one will change, and
what will happen if a task fails. Tell them to run `/overnight:start` when they are ready
for bed, and mention `/overnight:start --dry-run` if they want to see the plan walked
through first.
