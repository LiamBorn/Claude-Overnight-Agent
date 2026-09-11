'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { retry } = require('../src/retry');

test('returns the value on first success without retrying', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    return 'ok';
  });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 1);
});

test('retries until the call succeeds', async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'eventually';
    },
    { attempts: 5, baseDelayMs: 1 },
  );
  assert.strictEqual(result, 'eventually');
  assert.strictEqual(calls, 3);
});

test('gives up after the configured number of attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => retry(async () => { calls++; throw new Error('always fails'); }, { attempts: 3, baseDelayMs: 1 }),
    /always fails/,
  );
  assert.strictEqual(calls, 3);
});

test('backs off for longer after each failure', async () => {
  const delays = [];
  let calls = 0;
  await retry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'done';
    },
    { attempts: 5, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } },
  );
  assert.strictEqual(delays.length, 2);
  assert.ok(delays[1] > delays[0], `expected increasing delays, got ${delays.join(', ')}`);
});
