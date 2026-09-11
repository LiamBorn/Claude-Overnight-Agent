'use strict';

/**
 * Parse a short duration string into milliseconds.
 *
 * Supported today: milliseconds ("250ms"), seconds ("30s"), minutes ("5m"),
 * hours ("2h") and days ("1d").
 */
function parseDuration(input) {
  if (typeof input !== 'string') {
    throw new TypeError('parseDuration expects a string');
  }
  const match = input.trim().match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(`Unrecognized duration: ${input}`);
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unrecognized unit: ${match[2]}`);
  }
}

module.exports = { parseDuration };
