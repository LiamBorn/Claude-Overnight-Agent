# sample-repo

A tiny fixture project used to exercise the overnight-agent plugin end to end. It contains
three small modules and a deliberately incomplete test suite.

## Modules

- `src/parse-duration.js` — turns `"30s"` into milliseconds
- `src/retry.js` — retry an async function with backoff
- `src/format.js` — render a byte count as a human-readable string

## Usage

```js
const { parseDuration } = require('./src/parse-duration');
parseDuration('2h'); // 7200000 (also supports "ms", "s", "m", "d")

const { retry } = require('./src/retry');
await retry(() => fetchThing(), { attempts: 5, baseDelayMs: 200 });

const { formatBytes } = require('./src/format');
formatBytes(1536); // '1.5 KB'
```

## Running the tests

```bash
npm test
```
