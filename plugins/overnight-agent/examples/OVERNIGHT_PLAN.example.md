# Overnight plan — 2026-09-11

<!-- overnight-plan-format: 1 -->
<!--
  A realistic example for a TypeScript web service. Copy it, change the commands to match
  your project, and run /overnight:validate. The point of every task below is that its
  "done" condition is a command, not an opinion.
-->

## Settings

```yaml
stop_at: "07:00"
max_runtime_minutes: 480
max_tasks: 12
max_consecutive_failures: 3
task_timeout_minutes: 40
model: sonnet
reviewer_model: sonnet
baseline_command: npm test
allow_package_install: false
allow_network: false
on_failure: revert
```

## Task: T1 — Retry only on transient failures in the API client

```yaml
id: T1
priority: 1
depends_on: []
max_attempts: 2
scope:
  - src/lib/api-client.ts
  - src/lib/__tests__/api-client.test.ts
acceptance:
  - command: npm test -- src/lib/__tests__/api-client.test.ts
    expect: exit_zero
  - command: npx tsc --noEmit
    expect: exit_zero
```

### Goal

`apiClient.request` currently retries every thrown error three times, so a 400 caused by a
bad payload is sent three times and the user waits three times as long for the same failure.
Retry only on network errors and on 5xx responses. A 4xx must fail immediately and surface
the original error unchanged.

Add tests covering: a 500 that succeeds on the second try, a 400 that is attempted exactly
once, and a network error that exhausts the retry budget and rethrows.

### Notes

Keep the existing `RetryOptions` shape; callers depend on it. The backoff behaviour itself is
fine and should not change. Do not introduce a retry library, there is a perfectly good loop
in there already.

## Task: T2 — Stop logging request bodies at info level

```yaml
id: T2
priority: 1
depends_on: []
max_attempts: 2
scope:
  - src/middleware/request-logger.ts
  - src/middleware/__tests__/request-logger.test.ts
acceptance:
  - command: npm test -- src/middleware
    expect: exit_zero
  - command: "! grep -rn 'body' src/middleware/request-logger.ts | grep -v redact"
    expect: exit_zero
    description: the logger no longer touches the raw body except through the redactor
```

### Goal

The request logger writes the full request body at info level, which means password-reset
payloads and API tokens end up in log aggregation. Log the method, path, status, duration and
a request id. If a body is logged at all, it must go through the existing `redact()` helper
in `src/lib/redact.ts`, which already knows the sensitive field names.

Add a test asserting that a request containing a `password` field produces a log line that
does not contain the password value.

### Notes

`redact()` is already imported elsewhere in the codebase; follow how `src/routes/auth.ts`
uses it. Do not change the log format for anything other than the body, because the
dashboards parse those fields.

## Task: T3 — Cover the date-range helpers with tests

```yaml
id: T3
priority: 2
depends_on: []
max_attempts: 2
scope:
  - src/lib/__tests__/date-range.test.ts
acceptance:
  - command: npm test -- src/lib/__tests__/date-range.test.ts
    expect: exit_zero
  - command: npx vitest run --coverage.enabled --coverage.include 'src/lib/date-range.ts' --coverage.thresholds.lines 90
    expect: exit_zero
```

### Goal

`src/lib/date-range.ts` has no tests, and the reporting bug last month came from it. Cover
its real behaviour: an ordinary range, a single-day range, a range crossing a month boundary,
a range crossing a year boundary, a range crossing a daylight-saving transition, and the two
invalid inputs where the end precedes the start and where either date is invalid.

### Notes

Do not modify `date-range.ts` itself. If a test reveals a genuine bug, write the test to
match the behaviour that is correct, let the task fail, and explain it in the report. A
failing task that found a real bug is a better outcome than a passing task that enshrined it.

## Task: T4 — Replace the deprecated `substr` calls

```yaml
id: T4
priority: 3
depends_on: []
max_attempts: 2
scope:
  - src/
acceptance:
  - command: "! grep -rn '\\.substr(' src/ --include='*.ts' --include='*.tsx'"
    expect: exit_zero
  - command: npm test
    expect: exit_zero
  - command: npx tsc --noEmit
    expect: exit_zero
```

### Goal

`String.prototype.substr` is deprecated and appears in about a dozen places. Replace each
call with `slice`, being careful that the second argument changes meaning: `substr(start,
length)` becomes `slice(start, start + length)`, and a negative start behaves differently.
Get each one right individually rather than applying a blanket search and replace.

### Notes

The whole of `src/` is in scope because the calls are scattered, but nothing else should
change: no reformatting, no unrelated tidying, no import reordering. The full test suite is
an acceptance criterion precisely because this task touches many files.

## Task: T5 — Document the environment variables

```yaml
id: T5
priority: 4
depends_on: [T2]
max_attempts: 2
scope:
  - docs/configuration.md
acceptance:
  - command: node scripts/check-env-docs.js
    expect: exit_zero
    description: every process.env key used in src/ appears in docs/configuration.md
```

### Goal

`docs/configuration.md` is missing roughly half the environment variables the service reads,
which is why onboarding takes a day. Document every variable `src/` actually reads: what it
does, whether it is required, its default, and an example value. `scripts/check-env-docs.js`
already exists and compares the two, so it tells you exactly which keys are missing.

This runs after T2 because that task may change which variables the logger consults.

### Notes

Do not invent defaults. If the code does not specify one, say the variable is required.
Never write a real secret into the docs; use an obviously fake example value.
