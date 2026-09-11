'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseDuration } = require('../src/parse-duration');

test('parses milliseconds', () => {
  assert.strictEqual(parseDuration('250ms'), 250);
});

test('parses seconds', () => {
  assert.strictEqual(parseDuration('30s'), 30_000);
});

test('parses minutes', () => {
  assert.strictEqual(parseDuration('5m'), 300_000);
});

test('parses hours', () => {
  assert.strictEqual(parseDuration('2h'), 7_200_000);
});

test('parses days', () => {
  assert.strictEqual(parseDuration('1d'), 86_400_000);
});

test('rejects nonsense', () => {
  assert.throws(() => parseDuration('soon'), /Unrecognized duration/);
});
