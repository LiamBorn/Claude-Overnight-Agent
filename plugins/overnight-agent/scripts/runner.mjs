#!/usr/bin/env node
/**
 * runner.mjs — the overnight supervisor.
 *
 * One process per task, spawned fresh, watched from outside. The supervisor owns git,
 * owns the state file, runs the acceptance commands itself, and decides what "done"
 * means. A worker cannot mark its own work complete, cannot commit, and cannot outlive
 * its wall-clock budget.
 *
 * Usage:
 *   node runner.mjs --repo <dir> [--plan OVERNIGHT_PLAN.md] [--dry-run] [--resume]
 *
 * Test hooks (used by selftest.mjs, never in real runs):
 *   OVERNIGHT_CLAUDE_BIN   substitute binary for `claude`
 *   OVERNIGHT_NOW_OFFSET   milliseconds added to every clock reading
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validatePlan } from './validate.mjs';
import { nextOccurrence } from './config.mjs';
import * as git from './gitops.mjs';
import * as S from './state.mjs';
import {
  OUTCOME,
  classifyRun,
  errorFingerprint,
  detectCheatSignals,
  scopeViolations,
} from './classify.mjs';
import { writeReport, writeDryRunReport } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const CLAUDE_BIN = process.env.OVERNIGHT_CLAUDE_BIN || 'claude';

const now = () => Date.now() + Number(process.env.OVERNIGHT_NOW_OFFSET || 0);

// --- structured output contracts ------------------------------------------

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'partial', 'blocked'] },
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    files_changed: { type: 'array', items: { type: 'string' } },
    acceptance_run: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          exit_code: { type: 'number' },
        },
        required: ['command', 'exit_code'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['status', 'summary', 'assumptions', 'questions', 'files_changed'],
};

const REVIEWER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    reasons: { type: 'array', items: { type: 'string' } },
    achieved_goal: { type: 'boolean' },
    stayed_in_scope: { type: 'boolean' },
    obtained_honestly: { type: 'boolean' },
    dishonesty_detail: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    suggested_fix: { type: 'string' },
  },
  required: ['verdict', 'reasons', 'achieved_goal', 'stayed_in_scope', 'obtained_honestly'],
};

// --- process plumbing ------------------------------------------------------

/**
 * Spawn a child with a hard wall-clock limit. SIGTERM first so Claude Code can run its
 * SessionEnd hooks and record the session, SIGKILL if it does not go.
 */
function runProcess(command, args, { cwd, env, input, timeoutMs, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (onSpawn) onSpawn(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut, spawnError: error.message });
    });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });

    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** Run one acceptance command. Deterministic, no model involved. */
function runAcceptanceCommand(repoRoot, entry, timeoutMs) {
  const started = now();
  const result = spawnSync('/bin/sh', ['-c', entry.command], {
    cwd: entry.cwd ? path.resolve(repoRoot, entry.cwd) : repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const exitCode = result.status === null ? 124 : result.status;
  const wanted = entry.expect === 'exit_nonzero' ? exitCode !== 0 : exitCode === 0;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    command: entry.command,
    expect: entry.expect,
    exit_code: exitCode,
    passed: wanted,
    duration_ms: now() - started,
    killed: result.status === null,
    output: output.length > 8000 ? `${output.slice(0, 4000)}\n…\n${output.slice(-4000)}` : output,
  };
}

// --- prompt construction ---------------------------------------------------

/** The agent files are the single source of truth for each role's instructions. */
function agentBody(name) {
  const file = path.join(PLUGIN_ROOT, 'agents', `${name}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  return match ? text.slice(match[0].length).trim() : text.trim();
}

function describeAcceptance(task) {
  return task.acceptance
    .map((entry, index) => {
      if (entry.command) {
        const expectation = entry.expect === 'exit_nonzero' ? 'must exit non-zero' : 'must exit 0';
        return `${index + 1}. \`${entry.command}\` — ${expectation}${entry.description ? ` (${entry.description})` : ''}`;
      }
      return `${index + 1}. ${entry.check} — judged by the reviewer, not run as a command`;
    })
    .join('\n');
}

function workerContext(state, task, taskSpec, priorAttempt) {
  const parts = [];
  parts.push(`# Task ${task.id}: ${task.title}\n`);
  parts.push(`## Goal\n\n${taskSpec.goal}\n`);
  parts.push(
    `## Files and directories in scope\n\n${
      taskSpec.scope.length ? taskSpec.scope.map((s) => `- ${s}`).join('\n') : '- (not declared; stay close to what the goal describes)'
    }\n`,
  );
  parts.push(`## Acceptance criteria\n\nThe supervisor runs these itself after you finish, on the real tree. Run them yourself first.\n\n${describeAcceptance(taskSpec)}\n`);
  if (taskSpec.notes) parts.push(`## Notes and constraints\n\n${taskSpec.notes}\n`);

  parts.push(
    `## Repository\n\n- Working directory: ${state.repo_root}\n- Branch: ${state.branch} (all work stays here; you cannot switch branches)\n- Starting commit: ${task.base_commit}\n- Network: ${state.settings.allow_network ? 'allowed' : 'blocked'}\n- Package installs: ${taskSpec.allow_package_install ?? state.settings.allow_package_install ? 'allowed' : 'blocked'}\n`,
  );

  if (priorAttempt) {
    parts.push(`## Previous attempt (attempt ${priorAttempt.n}) failed — read this first\n`);
    parts.push(`Outcome: ${priorAttempt.outcome}. ${priorAttempt.detail ?? ''}\n`);
    if (priorAttempt.acceptance?.length) {
      parts.push('Acceptance results from that attempt:\n');
      for (const result of priorAttempt.acceptance) {
        parts.push(`- \`${result.command}\` exited ${result.exit_code} (${result.passed ? 'passed' : 'FAILED'})`);
        if (!result.passed && result.output) {
          parts.push(`\n\`\`\`\n${result.output.slice(-2000)}\n\`\`\`\n`);
        }
      }
      parts.push('');
    }
    if (priorAttempt.review_reasons?.length) {
      parts.push(`The independent reviewer rejected it:\n${priorAttempt.review_reasons.map((r) => `- ${r}`).join('\n')}\n`);
    }
    if (priorAttempt.suggested_fix) parts.push(`Reviewer's suggestion: ${priorAttempt.suggested_fix}\n`);
    parts.push('The working tree has been reset to the starting commit, so you are beginning again from clean. Do not repeat the approach that failed.\n');
  }

  return parts.join('\n');
}

function reviewerContext(state, task, taskSpec, evidence) {
  const parts = [];
  parts.push(`# Review of task ${task.id}: ${task.title}\n`);
  parts.push(`## The goal as written\n\n${taskSpec.goal}\n`);
  if (taskSpec.notes) parts.push(`## Notes and constraints from the plan\n\n${taskSpec.notes}\n`);
  parts.push(`## Declared scope\n\n${taskSpec.scope.length ? taskSpec.scope.map((s) => `- ${s}`).join('\n') : '- none declared'}\n`);

  parts.push('## Acceptance commands, as run by the supervisor\n');
  for (const result of evidence.acceptance) {
    parts.push(`- \`${result.command}\` exited ${result.exit_code} — ${result.passed ? 'PASSED' : 'FAILED'}`);
  }
  parts.push('\nThese are facts. Do not re-run them.\n');

  parts.push(`## Files changed (${evidence.changedFiles.length})\n\n${evidence.changedFiles.map((f) => `- ${f}`).join('\n') || '- none'}\n`);

  if (evidence.scopeViolations.length) {
    parts.push(`## Outside the declared scope\n\n${evidence.scopeViolations.map((f) => `- ${f}`).join('\n')}\n\nDecide whether the goal justifies each of these.\n`);
  }

  if (evidence.cheatFlags.length) {
    parts.push(`## Automated shortcut scan flagged these — verify each against the diff\n\n${evidence.cheatFlags.map((f) => `- ${f}`).join('\n')}\n`);
  }

  if (evidence.workerReport) {
    parts.push(`## What the worker said it did\n\n${evidence.workerReport.summary ?? '(no summary)'}\n`);
    if (evidence.workerReport.assumptions?.length) {
      parts.push(`Assumptions it recorded:\n${evidence.workerReport.assumptions.map((a) => `- ${a}`).join('\n')}\n`);
    }
    parts.push('Treat this as a claim to check, not as evidence.\n');
  }

  parts.push(`## The diff\n\n\`\`\`diff\n${evidence.diff}\n\`\`\`\n`);
  return parts.join('\n');
}

// --- claude invocation -----------------------------------------------------

function buildSettingsFile(state) {
  const template = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'overnight-settings.json'), 'utf8'));
  delete template._comment;
  const settings = state.settings;

  if (!settings.allow_package_install) {
    template.permissions.deny.push(
      'Bash(npm install *)', 'Bash(npm i *)', 'Bash(npm ci *)', 'Bash(npm add *)',
      'Bash(yarn add *)', 'Bash(pnpm add *)', 'Bash(pnpm install *)',
      'Bash(pip install *)', 'Bash(pip3 install *)', 'Bash(poetry add *)',
      'Bash(cargo add *)', 'Bash(go get *)', 'Bash(gem install *)',
      'Bash(brew install *)', 'Bash(brew upgrade *)', 'Bash(apt-get install *)', 'Bash(apt install *)',
    );
  }
  if (!settings.allow_network) {
    template.permissions.deny.push('WebFetch', 'WebSearch');
  }

  // Carry the guard hook in the settings file as well as the plugin, so the runner works
  // whether or not the plugin happens to be installed in this environment. When both are
  // present the hook simply runs twice and returns the same answer.
  template.hooks = {
    PreToolUse: [
      {
        matcher: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch',
        hooks: [{ type: 'command', command: `node ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs'))}`, timeout: 20 }],
      },
    ],
  };

  const destination = path.join(S.paths(state.repo_root).dir, 'worker-settings.json');
  fs.writeFileSync(destination, `${JSON.stringify(template, null, 2)}\n`);
  return destination;
}

function claudeEnv(state, taskSpec) {
  const allowInstall = taskSpec?.allow_package_install ?? state.settings.allow_package_install;
  return {
    ...process.env,
    OVERNIGHT_RUN: '1',
    OVERNIGHT_REPO_ROOT: state.repo_root,
    OVERNIGHT_BRANCH: state.branch,
    OVERNIGHT_ALLOW_NETWORK: state.settings.allow_network ? '1' : '0',
    OVERNIGHT_ALLOW_INSTALL: allowInstall ? '1' : '0',
    CI: '1',
    NO_COLOR: '1',
  };
}

async function invokeClaude(state, {
  directive,
  context,
  systemPromptFile,
  schema,
  model,
  settingsFile,
  timeoutMs,
  taskSpec,
  label,
}) {
  const args = [
    '-p', directive,
    '--model', model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt-file', systemPromptFile,
    '--settings', settingsFile,
    '--permission-mode', 'acceptEdits',
    '--max-turns', String(state.settings.max_turns),
  ];
  if (state.supports_permission_prompts) args.push('--permission-prompts', 'none');

  const started = now();
  const child = await runProcess(CLAUDE_BIN, args, {
    cwd: state.repo_root,
    env: claudeEnv(state, taskSpec),
    input: context,
    timeoutMs,
  });
  const classification = classifyRun(child);

  // Keep the raw transcript; the morning report links to it for anything that went wrong.
  const transcriptPath = path.join(S.paths(state.repo_root).transcripts, `${label}.json`);
  try {
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ args: args.map((a) => (a.length > 2000 ? `${a.slice(0, 2000)}…` : a)), duration_ms: now() - started, status: child.status, signal: child.signal, timedOut: child.timedOut, stdout: child.stdout, stderr: child.stderr }, null, 2)}\n`,
    );
  } catch { /* a transcript we cannot write must not fail the task */ }

  let structured = null;
  if (classification.result) {
    structured = classification.result.structured_output
      ?? safeParse(classification.result.result);
  }
  return { classification, structured, child, transcriptPath, duration_ms: now() - started };
}

function safeParse(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// --- scheduling ------------------------------------------------------------

/** Sleep, but wake early for a stop request and never sleep past the run's deadline. */
async function interruptibleSleep(state, ms, reason) {
  const stopFile = S.paths(state.repo_root).stop;
  const deadline = Math.min(now() + ms, Date.parse(state.stop_at));
  while (now() < deadline) {
    if (fs.existsSync(stopFile)) return 'stopped';
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, deadline - now())));
  }
  return now() >= Date.parse(state.stop_at) ? 'deadline' : 'done';
}

function stopCondition(state) {
  if (fs.existsSync(S.paths(state.repo_root).stop)) return 'you asked it to stop';
  if (now() >= Date.parse(state.stop_at)) return `the stop time (${new Date(state.stop_at).toLocaleString()}) was reached`;
  const counts = S.countByStatus(state);
  const finished = counts.done + counts.failed + counts.blocked + counts.skipped;
  if (finished >= state.settings.max_tasks) return `the task limit (${state.settings.max_tasks}) was reached`;
  if (state.consecutive_failures >= state.settings.max_consecutive_failures) {
    return `${state.consecutive_failures} tasks failed in a row, which hit the max_consecutive_failures limit`;
  }
  return null;
}

/** Next runnable task: dependencies satisfied, attempts left, lowest priority number first. */
function pickTask(state) {
  const candidates = Object.values(state.tasks).filter((task) => {
    if (task.status !== S.TASK_STATUS.PENDING) return false;
    if (task.attempts >= task.max_attempts) return false;
    return task.depends_on.every((dep) => state.tasks[dep]?.status === S.TASK_STATUS.DONE);
  });
  candidates.sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/** When a task can never finish, nothing downstream of it can either. */
function skipDependents(state, rootId, reason) {
  const skipped = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of Object.values(state.tasks)) {
      if (task.status !== S.TASK_STATUS.PENDING) continue;
      const blocker = task.depends_on.find((dep) => {
        const upstream = state.tasks[dep];
        return upstream && [S.TASK_STATUS.FAILED, S.TASK_STATUS.BLOCKED, S.TASK_STATUS.SKIPPED].includes(upstream.status);
      });
      if (blocker) {
        task.status = S.TASK_STATUS.SKIPPED;
        task.reason = `Skipped because it depends on ${blocker}, which did not complete (${reason}).`;
        task.finished_at = new Date(now()).toISOString();
        skipped.push(task.id);
        changed = true;
      }
    }
  }
  return skipped;
}

function isStuck(task, threshold) {
  const fingerprints = task.attempt_log.map((a) => a.error_fingerprint).filter(Boolean);
  if (fingerprints.length < threshold) return null;
  const recent = fingerprints.slice(-threshold);
  return recent.every((f) => f === recent[0]) ? recent[0] : null;
}

// --- the task cycle --------------------------------------------------------

async function executeTask(state, task, taskSpec, settingsFile) {
  const repoRoot = state.repo_root;
  const timeoutMs = state.settings.task_timeout_minutes * 60_000;

  task.status = S.TASK_STATUS.RUNNING;
  task.started_at = new Date(now()).toISOString();
  task.base_commit = git.headCommit(repoRoot);
  S.writeState(repoRoot, state);
  S.appendLog(repoRoot, `Task **${task.id}** — ${task.title}`, { heading: true });
  S.appendLog(repoRoot, `attempt ${task.attempts + 1} of ${task.max_attempts}, starting from ${task.base_commit.slice(0, 8)}`);

  const priorAttempt = task.attempt_log.length ? task.attempt_log[task.attempt_log.length - 1] : null;
  const attemptNumber = task.attempts + 1;
  const label = `${task.id}-attempt${attemptNumber}`;

  // ---- 1. the worker ------------------------------------------------------
  const workerRun = await invokeClaude(state, {
    directive:
      'The task you must complete is on stdin. Work through it now and finish with the structured result object. Nobody is awake to answer questions.',
    context: workerContext(state, task, taskSpec, priorAttempt),
    systemPromptFile: writeSystemPrompt(repoRoot, 'worker'),
    schema: WORKER_SCHEMA,
    model: state.settings.model,
    settingsFile,
    timeoutMs,
    taskSpec,
    label: `${label}-worker`,
  });

  if (workerRun.classification.outcome === OUTCOME.USAGE_LIMIT) {
    return { kind: 'usage_limit', classification: workerRun.classification };
  }
  if (workerRun.classification.outcome === OUTCOME.AUTH) {
    return { kind: 'auth', classification: workerRun.classification };
  }

  const workerReport = workerRun.structured;
  S.appendLog(
    repoRoot,
    `worker finished in ${(workerRun.duration_ms / 1000).toFixed(0)}s — ${workerRun.classification.outcome}${workerReport?.status ? ` / reported "${workerReport.status}"` : ''}`,
  );

  // ---- 2. the acceptance commands, run by the supervisor ------------------
  const acceptance = [];
  for (const entry of taskSpec.acceptance) {
    if (!entry.command) continue;
    const result = runAcceptanceCommand(repoRoot, entry, Math.min(timeoutMs, 20 * 60_000));
    acceptance.push(result);
    S.appendLog(repoRoot, `acceptance \`${entry.command}\` → exit ${result.exit_code} (${result.passed ? 'pass' : 'FAIL'})`);
  }

  const changedFiles = git.changedFiles(repoRoot, task.base_commit);
  const { text: diff } = git.diffText(repoRoot, task.base_commit);
  const violations = scopeViolations(changedFiles, taskSpec.scope);
  const cheatFlags = detectCheatSignals(diff, {
    acceptanceCommands: taskSpec.acceptance.map((a) => a.command).filter(Boolean),
  });
  task.scope_violations = violations;
  task.cheat_flags = cheatFlags;

  const attempt = {
    n: attemptNumber,
    started_at: task.started_at,
    ended_at: new Date(now()).toISOString(),
    outcome: workerRun.classification.outcome,
    detail: workerRun.classification.detail,
    worker_status: workerReport?.status ?? null,
    duration_ms: workerRun.duration_ms,
    acceptance,
    changed_files: changedFiles,
    scope_violations: violations,
    cheat_flags: cheatFlags,
    transcript: path.relative(repoRoot, workerRun.transcriptPath),
  };

  if (workerReport?.assumptions?.length) task.assumptions.push(...workerReport.assumptions);
  if (workerReport?.questions?.length) task.questions.push(...workerReport.questions);
  if (workerReport?.summary) attempt.summary = workerReport.summary;

  // Hard failures that never reach the reviewer.
  if (workerRun.classification.outcome !== OUTCOME.SUCCESS) {
    attempt.error_fingerprint = errorFingerprint(`${workerRun.classification.outcome} ${workerRun.classification.detail}`);
    return { kind: 'fail', attempt, reason: `The worker session ended as ${workerRun.classification.outcome}: ${workerRun.classification.detail}` };
  }
  if (workerReport?.status === 'blocked') {
    attempt.error_fingerprint = errorFingerprint(`blocked ${workerReport.summary}`);
    return {
      kind: 'blocked',
      attempt,
      reason: `The worker reported it was blocked: ${workerReport.summary}`,
    };
  }
  if (changedFiles.length === 0) {
    attempt.error_fingerprint = errorFingerprint('no changes produced');
    return { kind: 'fail', attempt, reason: 'The worker changed nothing, so there is nothing to verify or commit.' };
  }
  const failedCommands = acceptance.filter((a) => !a.passed);
  if (failedCommands.length) {
    attempt.error_fingerprint = errorFingerprint(failedCommands.map((f) => `${f.command} ${f.output}`).join('\n'));
    return {
      kind: 'fail',
      attempt,
      reason: `Acceptance failed: ${failedCommands.map((f) => `\`${f.command}\` exited ${f.exit_code}`).join('; ')}`,
    };
  }

  // ---- 3. the independent reviewer ---------------------------------------
  if (state.settings.skip_review) {
    attempt.review = { verdict: 'pass', reasons: ['review skipped by configuration'] };
    return { kind: 'pass', attempt, workerReport };
  }

  const reviewRun = await invokeClaude(state, {
    directive:
      'The work to review is on stdin. Decide whether this task is genuinely finished and return the structured verdict. The acceptance commands have already been run for you; do not run them again.',
    context: reviewerContext(state, task, taskSpec, {
      acceptance,
      changedFiles,
      scopeViolations: violations,
      cheatFlags,
      workerReport,
      diff,
    }),
    systemPromptFile: writeSystemPrompt(repoRoot, 'reviewer'),
    schema: REVIEWER_SCHEMA,
    model: state.settings.reviewer_model,
    settingsFile,
    timeoutMs,
    taskSpec,
    label: `${label}-review`,
  });

  if (reviewRun.classification.outcome === OUTCOME.USAGE_LIMIT) {
    return { kind: 'usage_limit', classification: reviewRun.classification, partialAttempt: attempt };
  }

  const review = reviewRun.structured;
  attempt.review = review;
  attempt.review_transcript = path.relative(repoRoot, reviewRun.transcriptPath);

  if (review?.assumptions?.length) task.assumptions.push(...review.assumptions);
  if (review?.questions?.length) task.questions.push(...review.questions);

  if (reviewRun.classification.outcome !== OUTCOME.SUCCESS || !review) {
    // A reviewer that cannot answer is not a pass. Unverified work does not get committed.
    attempt.error_fingerprint = errorFingerprint(`review unavailable ${reviewRun.classification.detail}`);
    return {
      kind: 'fail',
      attempt,
      reason: `The reviewer session did not return a verdict (${reviewRun.classification.outcome}). Work that nothing verified is not committed.`,
    };
  }

  S.appendLog(repoRoot, `reviewer verdict: **${review.verdict}**${review.reasons?.length ? ` — ${review.reasons[0]}` : ''}`);

  if (review.verdict !== 'pass') {
    attempt.review_reasons = review.reasons ?? [];
    attempt.suggested_fix = review.suggested_fix ?? null;
    attempt.error_fingerprint = errorFingerprint((review.reasons ?? []).join('\n'));
    return { kind: 'fail', attempt, reason: `The reviewer rejected it: ${(review.reasons ?? ['no reason given'])[0]}` };
  }

  return { kind: 'pass', attempt, workerReport, review };
}

function writeSystemPrompt(repoRoot, role) {
  const destination = path.join(S.paths(repoRoot).dir, `${role}-system-prompt.md`);
  fs.writeFileSync(destination, `${agentBody(role === 'worker' ? 'overnight-worker' : 'overnight-reviewer')}\n`);
  return destination;
}

// --- the run ---------------------------------------------------------------

async function mainLoop(state, specsById, settingsFile) {
  const repoRoot = state.repo_root;
  let limitWaitSeconds = state.settings.limit_backoff_start_seconds;

  while (true) {
    const reason = stopCondition(state);
    if (reason) {
      state.status = 'stopped';
      state.stop_reason = reason;
      S.recordEvent(state, 'stop', reason);
      S.appendLog(repoRoot, `Run stopping: ${reason}.`);
      S.writeState(repoRoot, state);
      return;
    }

    const task = pickTask(state);
    if (!task) {
      const pending = Object.values(state.tasks).filter((t) => t.status === S.TASK_STATUS.PENDING);
      if (pending.length) {
        for (const stuck of pending) {
          stuck.status = S.TASK_STATUS.BLOCKED;
          stuck.reason = stuck.attempts >= stuck.max_attempts
            ? `Used all ${stuck.max_attempts} attempts.`
            : `Waiting on dependencies that never completed: ${stuck.depends_on.join(', ')}.`;
          stuck.finished_at = new Date(now()).toISOString();
        }
      }
      state.status = 'complete';
      state.stop_reason = 'every task reached a terminal state';
      S.appendLog(repoRoot, 'No runnable tasks remain. Run complete.');
      S.writeState(repoRoot, state);
      return;
    }

    const spec = specsById.get(task.id);
    const result = await executeTask(state, task, spec, settingsFile);

    // --- usage limit: wait it out, do not spend an attempt ------------------
    if (result.kind === 'usage_limit') {
      task.status = S.TASK_STATUS.PENDING;
      const resetAt = result.classification.resetAt;
      const waitMs = resetAt && resetAt > now()
        ? (resetAt - now()) + 60_000
        : limitWaitSeconds * 1000;
      const until = new Date(now() + waitMs);
      S.recordEvent(state, 'usage_limit', result.classification.detail, { wait_ms: waitMs, until: until.toISOString() });
      S.appendLog(repoRoot, `Usage limit hit (${result.classification.detail}). Waiting until ${until.toLocaleString()}, then resuming task ${task.id}. This does not count as an attempt.`);
      S.writeState(repoRoot, state);

      const outcome = await interruptibleSleep(state, waitMs, 'usage limit');
      if (!resetAt) {
        limitWaitSeconds = Math.min(limitWaitSeconds * 2, state.settings.limit_backoff_max_seconds);
      }
      if (outcome === 'stopped' || outcome === 'deadline') continue; // the loop's stopCondition handles it
      continue;
    }

    if (result.kind === 'auth') {
      state.status = 'stopped';
      state.stop_reason = `Claude Code could not authenticate: ${result.classification.detail}`;
      task.status = S.TASK_STATUS.PENDING;
      S.appendLog(repoRoot, `Stopping: ${state.stop_reason}`);
      S.writeState(repoRoot, state);
      return;
    }

    // Record what the attempt amounted to, not just how its worker process exited. A
    // session can end cleanly and still have failed the task, and the report must say so.
    result.attempt.result = result.kind;
    result.attempt.reason = result.reason ?? null;
    task.attempts += 1;
    task.attempt_log.push(result.attempt);
    limitWaitSeconds = state.settings.limit_backoff_start_seconds;

    // --- success ----------------------------------------------------------
    if (result.kind === 'pass') {
      const message = buildCommitMessage(task, spec, result);
      const sha = git.commitAll(repoRoot, message);
      task.commit = sha;
      task.status = S.TASK_STATUS.DONE;
      task.finished_at = new Date(now()).toISOString();
      task.reason = null;
      state.consecutive_failures = 0;
      S.recordEvent(state, 'task_done', `${task.id} committed as ${sha?.slice(0, 8)}`);
      S.appendLog(repoRoot, `**${task.id} done** — committed ${sha?.slice(0, 8)}`);
      S.writeState(repoRoot, state);
      continue;
    }

    // --- failure ----------------------------------------------------------
    const stuckFingerprint = isStuck(task, state.settings.stuck_threshold);
    const exhausted = task.attempts >= task.max_attempts;
    const terminal = result.kind === 'blocked' || stuckFingerprint || exhausted;

    // Preserve the work before throwing it away.
    const patchPath = path.join(S.paths(repoRoot).failed, `${task.id}-attempt${result.attempt.n}.patch`);
    const saved = git.savePatch(repoRoot, task.base_commit, patchPath);
    if (saved) result.attempt.patch = path.relative(repoRoot, saved);

    if (state.settings.on_failure === 'revert') {
      git.resetTo(repoRoot, task.base_commit);
      S.appendLog(repoRoot, `Reverted the working tree to ${task.base_commit.slice(0, 8)}${saved ? `; the attempt is saved at ${path.relative(repoRoot, saved)}` : ''}.`);
    }

    if (terminal) {
      task.status = result.kind === 'blocked' || stuckFingerprint ? S.TASK_STATUS.BLOCKED : S.TASK_STATUS.FAILED;
      task.finished_at = new Date(now()).toISOString();
      task.reason = stuckFingerprint
        ? `Failed ${state.settings.stuck_threshold} times with the same error, so it was declared stuck rather than retried further. Last reason: ${result.reason}`
        : result.reason;
      state.consecutive_failures += 1;
      S.recordEvent(state, 'task_failed', `${task.id}: ${task.reason}`);
      S.appendLog(repoRoot, `**${task.id} ${task.status}** — ${task.reason}`);
      const skipped = skipDependents(state, task.id, task.status);
      if (skipped.length) S.appendLog(repoRoot, `Skipped ${skipped.join(', ')} because they depend on ${task.id}.`);
    } else {
      task.status = S.TASK_STATUS.PENDING;
      S.appendLog(repoRoot, `${task.id} attempt ${result.attempt.n} failed (${result.reason}). Retrying with the failure as input.`);
    }
    S.writeState(repoRoot, state);
  }
}

function buildCommitMessage(task, spec, result) {
  const lines = [`overnight(${task.id}): ${task.title}`, ''];
  if (result.workerReport?.summary) lines.push(result.workerReport.summary, '');
  const verified = result.attempt.acceptance.map((a) => `  - ${a.command} → exit ${a.exit_code}`);
  if (verified.length) {
    lines.push('Verified by:', ...verified, '');
  }
  if (result.review?.reasons?.length) {
    lines.push(`Reviewed: ${result.review.reasons[0]}`, '');
  }
  if (task.assumptions.length) {
    lines.push('Assumptions made:', ...task.assumptions.map((a) => `  - ${a}`), '');
  }
  lines.push('Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>');
  return lines.join('\n');
}

// --- setup and entry point -------------------------------------------------

function loadPlan(repoRoot, planFile) {
  const planPath = path.isAbsolute(planFile) ? planFile : path.join(repoRoot, planFile);
  const text = fs.readFileSync(planPath, 'utf8');
  const validation = validatePlan(text, { repoRoot });
  if (!validation.ok) {
    throw new Error(`The plan has ${validation.errors.length} problem(s) and will not be run:\n  - ${validation.errors.join('\n  - ')}`);
  }
  return {
    planPath,
    planHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
    ...validation,
  };
}

async function startRun({ repoRoot, planFile, resume, supportsPermissionPrompts, baselineResult }) {
  const loaded = loadPlan(repoRoot, planFile);
  const specsById = new Map(loaded.plan.tasks.map((t) => [t.id, t]));
  S.ensureDirs(repoRoot);
  git.excludeOvernightDir(repoRoot);

  let state = resume ? S.readState(repoRoot) : null;

  if (state && (state.status === 'running' || state.status === 'stopping')) {
    if (state.plan_hash !== loaded.planHash) {
      throw new Error(
        'The plan file changed since this run started. Finish or delete the existing run before starting a new one, so state and plan cannot disagree.',
      );
    }
    const recovered = S.reconcileAfterCrash(state);
    state.status = 'running';
    state.supports_permission_prompts = supportsPermissionPrompts;
    if (git.currentBranch(repoRoot) !== state.branch) git.checkout(repoRoot, state.branch);
    S.appendLog(repoRoot, `Resuming run ${state.run_id}${recovered.length ? `; ${recovered.join(', ')} was interrupted mid-task and is queued again` : ''}.`, { heading: true });
    S.writeState(repoRoot, state);
  } else {
    const planRelative = path.relative(repoRoot, loaded.planPath);
    const dirty = git.dirtyFilesExcept(repoRoot, [planRelative]);
    if (dirty.length) {
      throw new Error(
        `The working tree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 5).join(', ')}). Commit or stash first so the morning diff is entirely the run's own work.`,
      );
    }
    const baseBranch = git.currentBranch(repoRoot);
    const branch = git.pickBranchName(repoRoot, loaded.settings.branch_prefix);
    const baseCommit = git.headCommit(repoRoot);
    git.createAndCheckout(repoRoot, branch);

    // Record the plan on the branch before any work, so the branch carries the brief it
    // was built from and task commits stay free of plan edits.
    const planCommit = git.commitPath(
      repoRoot,
      planRelative,
      `overnight: record the plan for this run\n\nThe plan below drove every commit on ${branch}.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`,
    );

    const stopAtMs = Math.min(
      nextOccurrence(loaded.settings.stop_at, new Date(now())),
      now() + loaded.settings.max_runtime_minutes * 60_000,
    );
    state = S.createState({
      repoRoot,
      planPath: path.relative(repoRoot, loaded.planPath),
      planHash: loaded.planHash,
      branch,
      baseBranch,
      baseCommit: planCommit ?? baseCommit,
      settings: loaded.settings,
      tasks: loaded.plan.tasks,
      stopAtMs,
    });
    state.supports_permission_prompts = supportsPermissionPrompts;
    state.baseline = baselineResult ?? null;
    S.appendLog(repoRoot, `Overnight run started on \`${branch}\` from ${baseCommit.slice(0, 8)}; stopping by ${new Date(stopAtMs).toLocaleString()}.`, { heading: true });
    S.appendLog(repoRoot, `${loaded.plan.tasks.length} task(s): ${loaded.order.join(' → ')}`);
    S.writeState(repoRoot, state);
  }

  const settingsFile = buildSettingsFile(state);
  fs.writeFileSync(S.paths(repoRoot).pid, `${process.pid}\n`);

  try {
    await mainLoop(state, specsById, settingsFile);
  } catch (error) {
    state.status = 'stopped';
    state.stop_reason = `The runner itself failed: ${error.message}`;
    S.recordEvent(state, 'runner_error', error.stack ?? error.message);
    S.appendLog(repoRoot, `Runner error: ${error.message}`);
    S.writeState(repoRoot, state);
  }

  state.finished_at = new Date(now()).toISOString();
  S.writeState(repoRoot, state);

  await writeReport({ repoRoot, state, specsById, invokeClaude, buildSettingsFile, writeSystemPrompt });

  try { fs.unlinkSync(S.paths(repoRoot).pid); } catch { /* already gone */ }
  try { fs.unlinkSync(S.paths(repoRoot).stop); } catch { /* only present if stop was requested */ }

  return state;
}

async function dryRun({ repoRoot, planFile }) {
  const loaded = loadPlan(repoRoot, planFile);
  S.ensureDirs(repoRoot);
  // The dry run writes one report into .overnight/ and nothing else. Registering the
  // exclude keeps even that out of `git status`, so "changed nothing" stays literally true.
  if (git.isGitRepo(repoRoot)) git.excludeOvernightDir(repoRoot);
  const branch = git.isGitRepo(repoRoot)
    ? git.pickBranchName(repoRoot, loaded.settings.branch_prefix)
    : `${loaded.settings.branch_prefix}/<today>`;
  const stopAtMs = Math.min(
    nextOccurrence(loaded.settings.stop_at, new Date(now())),
    now() + loaded.settings.max_runtime_minutes * 60_000,
  );
  return writeDryRunReport({ repoRoot, loaded, branch, stopAtMs });
}

function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    plan: 'OVERNIGHT_PLAN.md',
    dryRun: false,
    resume: false,
    supportsPermissionPrompts: false,
    baseline: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--repo') args.repo = path.resolve(argv[++i]);
    else if (flag === '--plan') args.plan = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--resume') args.resume = true;
    else if (flag === '--permission-prompts-supported') args.supportsPermissionPrompts = true;
    else if (flag === '--baseline') args.baseline = JSON.parse(argv[++i]);
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const run = args.dryRun
    ? dryRun({ repoRoot: args.repo, planFile: args.plan })
    : startRun({
        repoRoot: args.repo,
        planFile: args.plan,
        resume: args.resume,
        supportsPermissionPrompts: args.supportsPermissionPrompts,
        baselineResult: args.baseline,
      });

  run
    .then((result) => {
      if (args.dryRun) {
        console.log(result.text);
      } else {
        const counts = S.countByStatus(result);
        console.log(`Run ${result.status}: ${counts.done} done, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.skipped} skipped.`);
        console.log(`Report: ${path.join(result.repo_root, '.overnight', 'MORNING_REPORT.md')}`);
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error(`overnight runner failed: ${error.message}`);
      process.exit(1);
    });
}

export { startRun, dryRun, pickTask, skipDependents, isStuck, runAcceptanceCommand, stopCondition };
export default { startRun, dryRun };
