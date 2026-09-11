'use strict';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an async function with exponential backoff.
 *
 * options.attempts    - max number of tries before giving up (default 3)
 * options.baseDelayMs - delay before the second attempt; doubles after each
 *                        subsequent failure (default 100)
 * options.sleep       - injectable delay function, defaults to a real timer
 */
async function retry(fn, options = {}) {
  const { attempts = 3, baseDelayMs = 100, sleep = defaultSleep } = options;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

module.exports = { retry };
