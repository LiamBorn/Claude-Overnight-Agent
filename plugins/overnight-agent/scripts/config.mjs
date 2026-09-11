/**
 * config.mjs — resolved run settings.
 *
 * Precedence, highest first:
 *   1. The plan's own `## Settings` block
 *   2. .overnight/config.json in the target repo
 *   3. CLAUDE_PLUGIN_OPTION_* environment variables (the plugin's userConfig)
 *   4. The defaults below
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  /** Branch is `${branch_prefix}/${YYYY-MM-DD}`. Never main, never an existing branch. */
  branch_prefix: 'overnight',
  /** Local wall-clock HH:MM the run must end by. The next occurrence is used. */
  stop_at: '07:00',
  /** Absolute ceiling on run length regardless of stop_at. */
  max_runtime_minutes: 600,
  /** Stop after this many tasks reach a terminal state. */
  max_tasks: 20,
  /** Stop the whole run after this many tasks fail back to back. */
  max_consecutive_failures: 3,
  /** Hard wall-clock kill for one worker or reviewer process. */
  task_timeout_minutes: 45,
  /** Agentic turn ceiling handed to `claude -p --max-turns`. */
  max_turns: 120,
  /** Model alias for worker sessions. */
  model: 'sonnet',
  /** Model alias for reviewer sessions. A second opinion is worth a capable model. */
  reviewer_model: 'sonnet',
  /** Command whose exit code is recorded before the run starts, for honest reporting. */
  baseline_command: null,
  /** Workers may run package installs only when this is true. */
  allow_package_install: false,
  /** Workers may reach the network only when this is true. */
  allow_network: false,
  /** After a task exhausts its attempts: 'revert' to its base commit, or 'keep' the mess. */
  on_failure: 'revert',
  /** Identical error fingerprints before a task is declared stuck. */
  stuck_threshold: 3,
  /** Seconds to wait after a usage limit before the first retry. Doubles, capped. */
  limit_backoff_start_seconds: 300,
  limit_backoff_max_seconds: 3600,
  /** Skip the independent reviewer. Strongly discouraged; the report stops being trustworthy. */
  skip_review: false,
  /** Ask Claude for a short narrative at the end of the report. */
  narrative_summary: true,
};

const NUMERIC_KEYS = new Set([
  'max_runtime_minutes',
  'max_tasks',
  'max_consecutive_failures',
  'task_timeout_minutes',
  'max_turns',
  'stuck_threshold',
  'limit_backoff_start_seconds',
  'limit_backoff_max_seconds',
]);

const BOOLEAN_KEYS = new Set([
  'allow_package_install',
  'allow_network',
  'skip_review',
  'narrative_summary',
]);

export function configFromEnv(env = process.env) {
  const out = {};
  if (env.CLAUDE_PLUGIN_OPTION_default_stop_at) out.stop_at = env.CLAUDE_PLUGIN_OPTION_default_stop_at;
  if (env.CLAUDE_PLUGIN_OPTION_default_model) out.model = env.CLAUDE_PLUGIN_OPTION_default_model;
  if (env.CLAUDE_PLUGIN_OPTION_default_task_timeout_minutes) {
    out.task_timeout_minutes = Number(env.CLAUDE_PLUGIN_OPTION_default_task_timeout_minutes);
  }
  return out;
}

export function readRepoConfig(repoRoot) {
  const file = path.join(repoRoot, '.overnight', 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`.overnight/config.json is not valid JSON: ${error.message}`);
  }
}

export function resolveSettings({ planSettings = {}, repoConfig = {}, env = process.env } = {}) {
  const merged = { ...DEFAULTS, ...configFromEnv(env), ...repoConfig, ...planSettings };
  const errors = [];

  for (const key of NUMERIC_KEYS) {
    const value = merged[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push(`setting "${key}" must be a positive number, got ${JSON.stringify(value)}`);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof merged[key] !== 'boolean') {
      errors.push(`setting "${key}" must be true or false, got ${JSON.stringify(merged[key])}`);
    }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(merged.stop_at))) {
    errors.push(`setting "stop_at" must be HH:MM in 24-hour local time, got ${JSON.stringify(merged.stop_at)}`);
  }
  if (!['revert', 'keep'].includes(merged.on_failure)) {
    errors.push(`setting "on_failure" must be "revert" or "keep", got ${JSON.stringify(merged.on_failure)}`);
  }
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(String(merged.branch_prefix))) {
    errors.push(`setting "branch_prefix" is not a usable branch name: ${JSON.stringify(merged.branch_prefix)}`);
  }
  if (/^(main|master|develop|trunk)$/i.test(String(merged.branch_prefix))) {
    errors.push('setting "branch_prefix" must not be a mainline branch name');
  }

  const unknown = Object.keys(planSettings).filter((key) => !(key in DEFAULTS));
  return { settings: merged, errors, unknown };
}

/** Next occurrence of HH:MM local time, as epoch milliseconds. */
export function nextOccurrence(hhmm, from = new Date()) {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  const target = new Date(from);
  target.setSeconds(0, 0);
  target.setHours(hours, minutes);
  if (target.getTime() <= from.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

export default { DEFAULTS, resolveSettings, readRepoConfig, configFromEnv, nextOccurrence };
