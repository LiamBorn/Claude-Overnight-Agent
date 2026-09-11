# sample-repo

A tiny fixture project used to exercise the overnight-agent plugin end to end. It contains
three small modules and a deliberately incomplete test suite.

## Modules

- `src/parse-duration.js` — turns `"30s"` into milliseconds
- `src/retry.js` — retry an async function with backoff
- `src/format.js` — render a byte count as a human-readable string

## Running the tests

```bash
npm test
```
