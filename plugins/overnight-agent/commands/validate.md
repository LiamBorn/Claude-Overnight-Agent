---
name: validate
description: Check OVERNIGHT_PLAN.md for vague acceptance criteria, dependency cycles, oversized tasks, and anything that would need a human mid-run.
argument-hint: "[path to plan, defaults to OVERNIGHT_PLAN.md]"
disable-model-invocation: true
allowed-tools: Read, Edit, Bash(node *)
---

Validate the overnight plan and help the user fix whatever it finds.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" --repo "${CLAUDE_PROJECT_DIR}" ${ARGUMENTS:+--plan "$ARGUMENTS"} || true`

## What to do with that

If it is clean, say so in one line, list the execution order, and point at
`/overnight:start`. Do not pad it out.

If there are errors, the run will refuse to start, so they have to be fixed. Work through
them with the user rather than at them:

- **A missing or unverifiable acceptance criterion** is the most common and the most
  important. Read the task, work out what command would actually prove it, and propose
  that specific command. Check it exists in this project before suggesting it.
- **A task that needs a person** means a decision was left open. Find out what the user
  would have said and write it into the goal, so the worker is not guessing at 3am.
- **A dependency cycle** means the plan describes something that can never start. Show
  them the cycle and propose which edge to cut.
- **A dangerous step** like pushing or deploying cannot run unattended at all. Take it out
  of the plan and note it as a morning step for the user.

Apply the fixes to the plan file directly when the fix is obvious and you are confident.
Ask first when it turns on a decision only the user can make.

Warnings do not block the run, but they are usually worth acting on. A task flagged as too
large is the one most likely to eat the night and produce nothing, so offer to split it.
A task with no declared scope makes drift undetectable, so offer to fill it in.

When you have made changes, run the validator again and report the result.
