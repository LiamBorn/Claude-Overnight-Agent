'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatBytes } = require('../src/format');

test('formats zero bytes', () => {
  assert.strictEqual(formatBytes(0), '0 B');
});

test('formats a value below one kilobyte', () => {
  assert.strictEqual(formatBytes(500), '500 B');
});

test('crosses the kilobyte boundary', () => {
  assert.strictEqual(formatBytes(1024), '1.0 KB');
});

test('crosses the megabyte boundary', () => {
  assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
});

test('crosses the gigabyte boundary', () => {
  assert.strictEqual(formatBytes(1024 * 1024 * 1024), '1.0 GB');
});

test('honors the decimals argument', () => {
  assert.strictEqual(formatBytes(1536, 2), '1.50 KB');
});

test('rejects a non-finite number', () => {
  assert.throws(() => formatBytes(Infinity), TypeError);
});

test('rejects a negative number', () => {
  assert.throws(() => formatBytes(-1), RangeError);
});
