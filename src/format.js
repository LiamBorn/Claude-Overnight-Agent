'use strict';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Render a byte count as a short human-readable string.
 * There are no tests for this module yet.
 */
function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes)) throw new TypeError('formatBytes expects a finite number');
  if (bytes < 0) throw new RangeError('formatBytes expects a non-negative number');
  if (bytes === 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(decimals);
  return `${rounded} ${UNITS[unit]}`;
}

module.exports = { formatBytes };
