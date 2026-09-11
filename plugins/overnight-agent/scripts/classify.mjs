/**
 * classify.mjs — turn a finished `claude -p` process into a decision.
 *
 * Three jobs:
 *   1. Decide what kind of outcome a child process was (success, usage limit, timeout…).
 *   2. Fingerprint errors so a task that fails the same way three times gets declared
 *      stuck instead of burning the night.
 *   3. Spot the ways a worker can appear to pass without doing the work.
 */

import crypto from 'node:crypto';

export const OUTCOME = {
  SUCCESS: 'success',
  USAGE_LIMIT: 'usage_limit',
  TIMEOUT: 'timeout',
  MAX_TURNS: 'max_turns',
  AUTH: 'auth_error',
  CRASH: 'crash',
  ERROR: 'error',
};

/** A usage or rate limit, as opposed to any other failure. Waiting fixes these; retrying does not. */
const LIMIT_PATTERNS = [
  /usage limit reached/i,
  /you'?ve hit your (session|weekly|opus|sonnet|haiku|five[- ]hour) limit/i,
  /rate[ _-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /credit balance is too low/i,
  /spend limit (reached|unavailable)/i,
  /server is temporarily limiting requests/i,
  /overloaded_error/i,
  /usage credits required/i,
];

const AUTH_PATTERNS = [
  /authentication_failed/i,
  /invalid[ _]api[ _]key/i,
  /please run \/login/i,
  /oauth[ _]org[ _]not[ _]allowed/i,
  /account[ _]on[ _]hold/i,
  /not logged in/i,
];

/**
 * Classify a child process result.
 * `child` is { status, signal, stdout, stderr, timedOut }.
 */
export function classifyRun(child) {
  const haystack = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;

  if (child.timedOut) {
    return { outcome: OUTCOME.TIMEOUT, detail: 'The process exceeded its wall-clock limit and was killed.' };
  }

  // The limit message can arrive on a zero exit, inside the JSON result, so check it first.
  const limitHit = LIMIT_PATTERNS.find((pattern) => pattern.test(haystack));
  if (limitHit) {
    return {
      outcome: OUTCOME.USAGE_LIMIT,
      detail: firstMatchingLine(haystack, limitHit) ?? 'A usage or rate limit was reported.',
      resetAt: parseResetTime(haystack),
    };
  }

  const authHit = AUTH_PATTERNS.find((pattern) => pattern.test(haystack));
  if (authHit) {
    return {
      outcome: OUTCOME.AUTH,
      detail: firstMatchingLine(haystack, authHit) ?? 'Claude Code could not authenticate.',
    };
  }

  const parsed = parseResultJson(child.stdout);

  if (parsed?.subtype === 'error_max_turns') {
    return { outcome: OUTCOME.MAX_TURNS, detail: 'The session ran out of agentic turns.', result: parsed };
  }

  if (child.signal) {
    return { outcome: OUTCOME.CRASH, detail: `The process was killed by ${child.signal}.` };
  }

  if (child.status !== 0) {
    return {
      outcome: OUTCOME.ERROR,
      detail: lastMeaningfulLine(child.stderr) || lastMeaningfulLine(child.stdout) || `Exited with status ${child.status}.`,
      result: parsed,
    };
  }

  if (parsed?.is_error) {
    return { outcome: OUTCOME.ERROR, detail: String(parsed.result ?? 'The run reported an error.'), result: parsed };
  }

  return { outcome: OUTCOME.SUCCESS, detail: 'Completed.', result: parsed };
}

/** `claude -p --output-format json` prints one JSON object; be forgiving about stray output around it. */
export function parseResultJson(stdout) {
  if (!stdout) return null;
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall back to the last balanced {...} block in the stream.
    const start = text.lastIndexOf('\n{');
    if (start !== -1) {
      try {
        return JSON.parse(text.slice(start + 1));
      } catch { /* fall through */ }
    }
    const first = text.indexOf('{');
    if (first !== -1) {
      try {
        return JSON.parse(text.slice(first));
      } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Claude Code does not expose a limit reset as a machine-readable field, so read it out
 * of the message when it is there and let the caller fall back to backoff when it is not.
 */
export function parseResetTime(text, now = new Date()) {
  if (!text) return null;

  const iso = text.match(/reset[s]?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?(?:[+-]\d{2}:?\d{2})?)/i);
  if (iso) {
    const when = Date.parse(iso[1]);
    if (Number.isFinite(when)) return when;
  }

  const epoch = text.match(/reset[s]?\s+(?:at\s+)?(\d{10,13})\b/i);
  if (epoch) {
    const raw = Number(epoch[1]);
    const when = raw > 1e12 ? raw : raw * 1000;
    if (when > now.getTime() - 86_400_000) return when;
  }

  const clock = text.match(/reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (hours <= 23 && minutes <= 59) {
      const target = new Date(now);
      target.setSeconds(0, 0);
      target.setHours(hours, minutes);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target.getTime();
    }
  }

  const relative = text.match(/(?:try again|retry|wait)\s+in\s+(\d+)\s*(second|minute|hour)s?/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit === 'hour' ? 3_600_000 : unit === 'minute' ? 60_000 : 1000;
    return now.getTime() + amount * ms;
  }

  return null;
}

/**
 * A stable identity for an error, so "the same thing went wrong again" is a decidable
 * question. Volatile parts — paths, numbers, hex, timestamps, durations — are erased.
 */
export function errorFingerprint(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '<ts>')
    .replace(/\/[^\s:'"]+/g, '<path>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds|m|min|minutes)\b/g, '<dur>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Ways a task can look finished without being finished. These do not decide anything on
 * their own; they are handed to the reviewer, which is the thing that judges intent.
 */
export function detectCheatSignals(diffText, { acceptanceCommands = [] } = {}) {
  const flags = [];
  const lines = String(diffText ?? '').split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));

  const skipPatterns = [
    { re: /\b(it|test|describe)\.(skip|todo)\s*\(/, why: 'a test was skipped' },
    { re: /\b(xit|xdescribe|xtest)\s*\(/, why: 'a test was disabled with x-prefix' },
    { re: /@(pytest\.mark\.)?skip/, why: 'a Python test was marked skip' },
    { re: /#\[ignore\]/, why: 'a Rust test was marked ignore' },
    { re: /t\.Skip\(/, why: 'a Go test was skipped' },
  ];
  for (const { re, why } of skipPatterns) {
    if (added.some((line) => re.test(line))) flags.push(`${why} in the new code`);
  }

  if (removed.some((line) => /\b(it|test)\s*\(/.test(line)) &&
      !added.some((line) => /\b(it|test)\s*\(/.test(line))) {
    flags.push('test cases were removed and none were added back');
  }

  const deletedTestFiles = lines
    .filter((l) => l.startsWith('--- a/'))
    .map((l) => l.slice(6))
    .filter((f) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f) || /^test_.*\.py$/.test(f));
  const recreated = new Set(lines.filter((l) => l.startsWith('+++ b/')).map((l) => l.slice(6)));
  for (const file of deletedTestFiles) {
    if (!recreated.has(file)) flags.push(`the test file ${file} was deleted`);
  }

  if (added.some((line) => /expect\(\s*(true|1)\s*\)\.(toBe|toEqual)\(\s*(true|1)\s*\)/.test(line))) {
    flags.push('a tautological assertion was added');
  }
  if (added.some((line) => /\bassert\s+True\b|\bassert\(\s*true\s*\)/i.test(line))) {
    flags.push('an assertion that can never fail was added');
  }

  const configTouched = lines
    .filter((l) => l.startsWith('+++ b/'))
    .map((l) => l.slice(6))
    .filter((f) => /(^|\/)(jest\.config|vitest\.config|pytest\.ini|setup\.cfg|tox\.ini|\.mocharc|karma\.conf)/.test(f));
  for (const file of configTouched) {
    flags.push(`the test runner's own configuration was changed (${file})`);
  }

  const ciTouched = lines
    .filter((l) => l.startsWith('+++ b/'))
    .map((l) => l.slice(6))
    .filter((f) => /(^|\/)\.github\/workflows\//.test(f) || /(^|\/)\.gitlab-ci\.yml$/.test(f));
  for (const file of ciTouched) flags.push(`a CI configuration file was changed (${file})`);

  for (const command of acceptanceCommands) {
    const scriptName = command.match(/npm\s+(?:run\s+)?([\w:-]+)/)?.[1];
    if (scriptName && added.some((line) => new RegExp(`"${scriptName}"\\s*:`).test(line))) {
      flags.push(`the npm script "${scriptName}" named in the acceptance criteria was itself edited`);
    }
  }

  if (added.some((line) => /@ts-(ignore|nocheck|expect-error)/.test(line))) {
    flags.push('type checking was suppressed with a ts-ignore-style comment');
  }
  if (added.some((line) => /#\s*type:\s*ignore|# noqa(?!:)/.test(line))) {
    flags.push('a type or lint check was suppressed with an ignore comment');
  }
  if (added.some((line) => /eslint-disable(?!-next-line\s+\S+\s+--)/.test(line))) {
    flags.push('lint rules were disabled rather than satisfied');
  }

  return [...new Set(flags)];
}

/** Which changed files fall outside the task's declared scope. */
export function scopeViolations(changedFiles, scope) {
  if (!scope || scope.length === 0) return [];
  const matchers = scope.map(toMatcher);
  return changedFiles.filter((file) => !matchers.some((match) => match(file)));
}

function toMatcher(pattern) {
  const clean = String(pattern).replace(/^\.\//, '').replace(/\/+$/, '');
  if (clean === '' || clean === '.') return () => true;
  if (clean.includes('*')) {
    const source = `^${clean
      .split('**')
      .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
      .join('.*')}$`;
    const regex = new RegExp(source);
    return (file) => regex.test(file);
  }
  // A bare path matches the file itself or anything beneath it if it is a directory.
  return (file) => file === clean || file.startsWith(`${clean}/`);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstMatchingLine(text, pattern) {
  return String(text).split('\n').find((line) => pattern.test(line))?.trim() ?? null;
}

function lastMeaningfulLine(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 500) : null;
}

export default {
  OUTCOME,
  classifyRun,
  parseResultJson,
  parseResetTime,
  errorFingerprint,
  detectCheatSignals,
  scopeViolations,
};
