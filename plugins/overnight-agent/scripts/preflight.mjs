#!/usr/bin/env node
/**
 * preflight.mjs — everything that should fail at bedtime rather than at 3am.
 *
 * Run interactively by /overnight:start so the user is still awake to fix what it finds.
 * Prints a JSON report with --json, a readable one otherwise.
 *
 * Usage: node preflight.mjs [--repo .] [--plan OVERNIGHT_PLAN.md] [--json] [--probe] [--baseline]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validatePlan } from './validate.mjs';
import { parseResultJson } from './classify.mjs';
import { nextOccurrence } from './config.mjs';
import * as git from './gitops.mjs';
import { readState, paths, countByStatus } from './state.mjs';

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

export function runPreflight({ repoRoot, planFile, probe = false, baseline = false } = {}) {
  const checks = [];
  const collected = { baselineResult: null };
  const add = (name, status, detail, fix = null) => checks.push({ name, status, detail, fix });
  let settings = null;
  let plan = null;
  let order = [];

  // --- runtime -------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) add('Node runtime', PASS, `Node ${process.versions.node}`);
  else add('Node runtime', FAIL, `Node ${process.versions.node} is too old`, 'Install Node 18 or newer.');

  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  let claudeVersion = null;
  if (claude.status === 0) {
    claudeVersion = claude.stdout.trim();
    add('Claude Code CLI', PASS, claudeVersion);
  } else {
    add('Claude Code CLI', FAIL, '`claude` is not on PATH', 'Install Claude Code and make sure `claude` runs in this shell.');
  }

  const supportsPermissionPrompts = versionAtLeast(claudeVersion, '2.1.259');
  add(
    'Unattended permission handling',
    supportsPermissionPrompts ? PASS : WARN,
    supportsPermissionPrompts
      ? '--permission-prompts none is available, so nothing can wait on a prompt'
      : `this Claude Code build predates --permission-prompts (needs 2.1.259+), falling back to deny-by-default rules`,
    supportsPermissionPrompts ? null : 'Upgrade Claude Code for the strongest anti-stall guarantee.',
  );

  // --- git -----------------------------------------------------------------
  if (!git.gitAvailable()) {
    add('git', FAIL, 'git is not on PATH', 'Install git.');
    return finish(checks, { repoRoot, settings, plan, order, claudeVersion, supportsPermissionPrompts });
  }
  if (!git.isGitRepo(repoRoot)) {
    add('git repository', FAIL, `${repoRoot} is not inside a git repository`, 'Run `git init` and make an initial commit first. The overnight run needs a branch to work on.');
    return finish(checks, { repoRoot, settings, plan, order, claudeVersion, supportsPermissionPrompts });
  }
  const root = git.repoRootOf(repoRoot) ?? repoRoot;
  add('git repository', PASS, root);

  if (!git.hasCommits(root)) {
    add('git history', FAIL, 'the repository has no commits yet', 'Make an initial commit so there is something to branch from and revert to.');
  } else {
    add('git history', PASS, `HEAD is ${git.headCommit(root).slice(0, 12)}`);
  }

  const branch = git.currentBranch(root);
  const dirty = git.dirtyFilesExcept(root, [planFile]);
  if (dirty.length === 0) {
    add('working tree', PASS, `clean on "${branch}" (the plan file itself may be uncommitted; the run records it on the branch)`);
  } else {
    add(
      'working tree',
      FAIL,
      `${dirty.length} uncommitted change(s) on "${branch}": ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? '…' : ''}`,
      'Commit or stash your work. The run starts from a clean tree so the morning diff is entirely its own.',
    );
  }

  const remotes = git.remoteNames(root);
  add(
    'remotes',
    PASS,
    remotes.length ? `${remotes.join(', ')} — nothing will be pushed to any of them` : 'none configured',
  );

  // --- plan ----------------------------------------------------------------
  const planPath = path.isAbsolute(planFile) ? planFile : path.join(root, planFile);
  if (!fs.existsSync(planPath)) {
    add('plan file', FAIL, `no plan at ${planPath}`, 'Run /overnight:plan to write one.');
    return finish(checks, { repoRoot: root, settings, plan, order, claudeVersion, supportsPermissionPrompts });
  }
  const planText = fs.readFileSync(planPath, 'utf8');
  const planHash = crypto.createHash('sha256').update(planText).digest('hex').slice(0, 16);
  const validation = validatePlan(planText, { repoRoot: root });
  plan = validation.plan;
  settings = validation.settings;
  order = validation.order;

  if (validation.ok) {
    add('plan validation', PASS, `${plan.tasks.length} task(s), order: ${order.join(' → ')}`);
  } else {
    add('plan validation', FAIL, `${validation.errors.length} problem(s): ${validation.errors[0]}`, 'Run /overnight:validate to see them all.');
  }
  for (const warning of validation.warnings) add('plan warning', WARN, warning);

  // --- schedule ------------------------------------------------------------
  if (settings) {
    const stopAt = nextOccurrence(settings.stop_at);
    const hours = (stopAt - Date.now()) / 3_600_000;
    const capped = Math.min(stopAt, Date.now() + settings.max_runtime_minutes * 60_000);
    add(
      'stop time',
      hours > 0.25 ? PASS : WARN,
      `${new Date(capped).toLocaleString()} (${hours.toFixed(1)}h from now, capped by max_runtime_minutes=${settings.max_runtime_minutes})`,
      hours <= 0.25 ? 'That is very soon. Check stop_at in the plan.' : null,
    );
    add('budget', PASS, `at most ${settings.max_tasks} tasks, ${settings.task_timeout_minutes} min per task, stopping after ${settings.max_consecutive_failures} failures in a row`);
    add(
      'network and installs',
      PASS,
      `network ${settings.allow_network ? 'ALLOWED' : 'blocked'}, package installs ${settings.allow_package_install ? 'ALLOWED' : 'blocked'}`,
    );
    if (settings.skip_review) {
      add('independent review', WARN, 'skip_review is on, so nothing verifies the worker except the acceptance commands', 'Leave skip_review off unless you have a specific reason.');
    } else {
      add('independent review', PASS, `every task is verified by a separate ${settings.reviewer_model} session before it is committed`);
    }
  }

  // --- existing run --------------------------------------------------------
  let resume = null;
  try {
    const existing = readState(root);
    if (existing) {
      const counts = countByStatus(existing);
      if (existing.status === 'running' || existing.status === 'stopping') {
        resume = existing;
        add(
          'previous run',
          WARN,
          `an interrupted run from ${existing.started_at} is still marked ${existing.status} on branch ${existing.branch} (${counts.done} done, ${counts.pending} pending)`,
          'Start will resume it rather than beginning again. Delete .overnight/state.json to start fresh.',
        );
      } else {
        add('previous run', PASS, `last run finished ${existing.finished_at ?? 'at an unknown time'}; its state will be archived`);
      }
    }
  } catch (error) {
    add('previous run', WARN, error.message, 'Move .overnight/state.json aside to start clean.');
  }

  // --- environment ---------------------------------------------------------
  if (os.platform() === 'darwin') {
    const hasCaffeinate = spawnSync('which', ['caffeinate'], { encoding: 'utf8' }).status === 0;
    add(
      'sleep prevention',
      hasCaffeinate ? PASS : WARN,
      hasCaffeinate
        ? 'caffeinate is available and the runner will use it to prevent idle sleep'
        : 'caffeinate not found; the Mac may sleep and pause the run',
    );
    add(
      'closing the lid',
      WARN,
      'closing a MacBook lid sleeps the machine even with caffeinate, unless it is on power with an external display. The run pauses and resumes on wake, but may wake past its stop time.',
      'Leave the lid open, or run this on a machine that stays awake.',
    );
  }

  try {
    const probeFile = path.join(root, '.overnight', '.writable');
    fs.mkdirSync(path.dirname(probeFile), { recursive: true });
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    add('state directory', PASS, `${path.join(root, '.overnight')} is writable`);
  } catch (error) {
    add('state directory', FAIL, `cannot write to .overnight: ${error.message}`);
  }

  // --- optional, slower checks --------------------------------------------
  if (baseline && settings?.baseline_command) {
    const started = Date.now();
    const result = spawnSync('/bin/sh', ['-c', settings.baseline_command], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    add(
      'baseline',
      PASS,
      `\`${settings.baseline_command}\` exited ${result.status} in ${seconds}s — recorded so the morning report can tell your pre-existing failures from ours`,
    );
    collected.baselineResult = { command: settings.baseline_command, exit_code: result.status, recorded_at: new Date().toISOString() };
  } else if (settings && !settings.baseline_command) {
    add('baseline', WARN, 'no baseline_command in the plan', 'Set one so the report can distinguish failures that were already there.');
  }

  if (probe && claude.status === 0) {
    const result = spawnSync('claude', ['-p', 'Reply with the single word: ready', '--max-turns', '1', '--output-format', 'json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const text = `${result.stdout}${result.stderr}`;
    // `claude -p --output-format json` reports a failed run as a zero exit with is_error set,
    // so read the JSON rather than trusting the exit status, and surface the human-readable
    // message rather than the whole payload.
    const parsed = parseResultJson(result.stdout);
    const message = String(parsed?.result ?? text).trim();
    const failed = parsed ? parsed.is_error === true : result.status !== 0 || /not logged in|authentication/i.test(text);

    if (!failed) {
      add('authentication', PASS, 'a headless call succeeded, so the overnight sessions will authenticate');
    } else {
      const notLoggedIn = /not logged in|please run \/login|invalid api key/i.test(message);
      add(
        'authentication',
        FAIL,
        notLoggedIn
          ? `the headless CLI is not signed in: ${message.slice(0, 120)}`
          : `a headless probe failed: ${message.slice(0, 200)}`,
        notLoggedIn
          ? 'Run `claude` in a terminal and sign in, then try again. The Claude desktop app keeps its session in-process and does not share it with the CLI, so being signed into the app is not enough.'
          : 'Check that `claude -p "reply with: ok" --max-turns 1` works from a plain terminal.',
      );
    }
  }

  return finish(checks, {
    repoRoot: root,
    settings,
    plan,
    order,
    planPath,
    planHash,
    claudeVersion,
    supportsPermissionPrompts,
    resume: resume ? { branch: resume.branch, started_at: resume.started_at } : null,
  }, collected);
}

function finish(checks, extra, collected = {}) {
  const failures = checks.filter((c) => c.status === FAIL);
  const warnings = checks.filter((c) => c.status === WARN);
  return {
    ok: failures.length === 0,
    checks,
    failures: failures.length,
    warnings: warnings.length,
    baselineResult: collected.baselineResult ?? null,
    ...extra,
  };
}

/** "2.1.252 (Claude Code)" >= "2.1.259"? */
export function versionAtLeast(versionString, minimum) {
  if (!versionString) return false;
  const found = String(versionString).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!found) return false;
  const actual = found.slice(1, 4).map(Number);
  const wanted = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] > wanted[i]) return true;
    if (actual[i] < wanted[i]) return false;
  }
  return true;
}

// --- CLI ------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const args = { repo: process.cwd(), plan: 'OVERNIGHT_PLAN.md', json: false, probe: false, baseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = argv[++i];
    else if (argv[i] === '--plan') args.plan = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--probe') args.probe = true;
    else if (argv[i] === '--baseline') args.baseline = true;
  }

  let report;
  try {
    report = runPreflight({ repoRoot: args.repo, planFile: args.plan, probe: args.probe, baseline: args.baseline });
  } catch (error) {
    report = { ok: false, checks: [{ name: 'preflight', status: FAIL, detail: error.message }], failures: 1, warnings: 0 };
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const symbol = { pass: '✓', warn: '!', fail: '✗' };
    for (const check of report.checks) {
      console.log(`${symbol[check.status]} ${check.name}: ${check.detail}`);
      if (check.fix) console.log(`    → ${check.fix}`);
    }
    console.log('');
    console.log(report.ok ? 'Preflight passed. Ready to start.' : `Preflight failed: ${report.failures} blocking problem(s).`);
  }
  process.exit(report.ok ? 0 : 1);
}

export default { runPreflight, versionAtLeast };
