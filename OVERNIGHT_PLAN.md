# Overnight plan — sample-repo

<!-- overnight-plan-format: 1 -->

## Settings

```yaml
stop_at: "07:00"
max_runtime_minutes: 120
max_tasks: 10
max_consecutive_failures: 3
task_timeout_minutes: 12
model: sonnet
reviewer_model: sonnet
baseline_command: npm test
allow_package_install: false
allow_network: false
on_failure: revert
```

## Task: T1 — Support hours and days in parseDuration

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

`parseDuration` understands milliseconds, seconds and minutes, but callers are already
writing durations like `"2h"` and `"1d"` in config files and getting an "Unrecognized
duration" error at startup. Extend it so `h` means hours and `d` means days, returning
milliseconds as the existing units do.

The tests in `test/parse-duration.test.js` already cover both new units and currently fail.
Do not change the test file; it describes the behaviour that is wanted.

### Notes

Keep the existing shape of the function. This is a small extension to the regular expression
and the switch, not a rewrite. Invalid input must still throw with the same message.

## Task: T2 — Implement retry with exponential backoff

```yaml
id: T2
priority: 1
depends_on: []
max_attempts: 3
scope:
  - src/retry.js
acceptance:
  - command: node --test test/retry.test.js
    expect: exit_zero
```

### Goal

`src/retry.js` is a stub that throws. Implement it so an async function that fails
intermittently can be retried with a delay that grows after each failure.

`test/retry.test.js` is the specification and must pass unchanged. It requires: the value is
returned on first success with no retry; retries continue until the call succeeds; the
function gives up after `options.attempts` tries and rejects with the last error; and the
delay between attempts increases. The tests inject `options.sleep`, so the delay must be
awaited through that function when it is supplied, defaulting to a real timer when it is not.

### Notes

`options` carries `attempts` (default 3), `baseDelayMs` (default 100), and `sleep`. Plain
exponential backoff is enough; no jitter, no external dependency. The module stays
CommonJS, like the rest of the project.

## Task: T3 — Add tests for formatBytes

```yaml
id: T3
priority: 2
depends_on: []
max_attempts: 2
scope:
  - test/format.test.js
acceptance:
  - command: node --test test/format.test.js
    expect: exit_zero
  - command: node -e "const s=require('fs').readFileSync('test/format.test.js','utf8'); process.exit(/formatBytes/.test(s) && s.split('test(').length - 1 >= 5 ? 0 : 1)"
    expect: exit_zero
    description: at least five distinct test cases that actually exercise formatBytes
```

### Goal

`src/format.js` has no tests at all, which makes it the module nobody dares change. Write
`test/format.test.js` covering its real behaviour: zero bytes, a value below one kilobyte,
values that cross the KB, MB and GB boundaries, the `decimals` argument, and the two error
cases for a non-finite number and a negative number.

### Notes

Follow the style of the existing test files: `node:test` and `node:assert`, CommonJS
requires, one behaviour per `test()` call. Do not modify `src/format.js`. If you find a
genuine bug in it while writing tests, leave the code alone, write the test to match the
behaviour that is correct, and say so clearly in your report rather than fixing it here.

## Task: T4 — Document usage in the README

```yaml
id: T4
priority: 3
depends_on: []
max_attempts: 2
scope:
  - README.md
acceptance:
  - command: grep -q "^## Usage" README.md
    expect: exit_zero
  - command: grep -q parseDuration README.md && grep -q formatBytes README.md && grep -q "retry(" README.md
    expect: exit_zero
```

### Goal

The README lists the modules but never shows how to call them. Add a `## Usage` section with
a short, correct code example for each of the three modules, using the real function names
and realistic arguments.

### Notes

Keep it brief: a couple of lines per module in a single fenced block or three small ones.
The examples must match the actual signatures, including the hour and day units once T1 is
done. Do not restructure the rest of the README.

## Task: T5 — Export the modules from a single entry point

```yaml
id: T5
priority: 4
depends_on: [T1, T2, T3]
max_attempts: 2
scope:
  - index.js
acceptance:
  - command: node -e "const m=require('./index.js'); process.exit(typeof m.parseDuration==='function' && typeof m.retry==='function' && typeof m.formatBytes==='function' ? 0 : 1)"
    expect: exit_zero
  - command: npm test
    expect: exit_zero
```

### Goal

`package.json` points `main` at `index.js`, which does not exist, so requiring this package
fails. Create it as a thin barrel that re-exports `parseDuration`, `retry` and `formatBytes`
from their modules.

This runs last because the second acceptance command is the full suite, which only passes
once the earlier tasks are done.

### Notes

A few lines of `require` and `module.exports`. No logic, no side effects at import time.
