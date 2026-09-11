# A real overnight run, start to finish

This directory is the complete, unedited output of one genuine run of the plugin against
`sample-repo`, on 11 September 2026. Nothing here was written by hand, and nothing was
tidied up afterwards.

The fixture went from **4 passing and 6 failing tests to 18 passing and 0 failing**, across
five commits, in seven minutes.

## What to look at

| File | What it is |
| --- | --- |
| [`MORNING_REPORT.md`](MORNING_REPORT.md) | The report the run produced. Start here. |
| [`run.diff`](run.diff) | Every line of code the run changed, 84 added and 4 removed. |
| [`log.md`](log.md) | Timestamped log of every decision the supervisor made. |
| [`state.json`](state.json) | The resumable run state, including each task's attempt log. |
| [`worker-settings.json`](worker-settings.json) | The exact permission set the sessions ran under. |
| [`transcripts/`](transcripts) | Raw stdout of all eleven headless sessions: a worker and a reviewer per task, plus the narrator. |

The git history is on two branches of this repository:

- **`demo/fixture-before`** — the fixture as it started, with its failing suite
- **`demo/overnight-2026-09-11`** — the branch the run produced, with the plan recorded as
  its first commit and one commit per completed task

Those branches have their own history, unrelated to `main`, because the fixture is a
standalone repository. Compare them directly:

```bash
git diff demo/fixture-before..demo/overnight-2026-09-11
```

## What the transcripts show

The interesting part is the reviewer. It was given the diff and the acceptance results but
not the worker's reasoning, and in every case it checked the claim against the source rather
than accepting a green test suite. On T3 it traced all eight assertions through the real
`formatBytes` implementation, including the digit-shifting loop and the rounding, before
agreeing the tests were honest.

The run also produced a genuine finding nobody asked for: `formatBytes` silently ignores its
`decimals` argument for inputs below one kilobyte. The worker noticed, left `src/format.js`
untouched because the task said not to modify it, and recorded the observation instead of
quietly fixing it. That is in the report under Assumptions.

## What this run does not demonstrate

Every task passed on its first attempt. This run therefore exercised none of the failure
machinery: no retry, no reviewer rejection, no revert-and-save-the-patch, no stuck detection,
no usage-limit backoff, no crash recovery. Those paths are covered by the 135 self-tests in
`plugins/overnight-agent/scripts/selftest.mjs`, which drive the real runner against a
deterministic stub, and not by the evidence in this directory.

## Reproducing it

```bash
cd sample-repo
git init && git add -A && git commit -m "fixture"
```

Then open Claude Code there and run `/overnight:start`. The results will differ in wording,
because the workers are real model sessions rather than a recording.

## One note on paths

The report and the transcripts contain absolute paths from the machine the run happened on.
They are left exactly as generated, because editing a run record to look tidier would defeat
the purpose of publishing it.
