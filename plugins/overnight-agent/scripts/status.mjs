#!/usr/bin/env node
/**
 * status.mjs — what is happening right now, readable at a glance.
 *
 * Safe to run mid-run: it only reads. Usage: node status.mjs [--repo .] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './state.mjs';
import * as git from './gitops.mjs';

const SYMBOL = {
  done: '✓',
  failed: '✗',
  blocked: '■',
  skipped: '–',
  running: '▶',
  pending: '·',
};

function runnerAlive(repoRoot) {
  const pidFile = S.paths(repoRoot).pid;
  if (!fs.existsSync(pidFile)) return { alive: false, pid: null };
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid)) return { alive: false, pid: null };
  try {
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid };
  }
}

export function collectStatus(repoRoot) {
  const state = S.readState(repoRoot);
  if (!state) return null;
  const counts = S.countByStatus(state);
  const { alive, pid } = runnerAlive(repoRoot);
  const stopRequested = fs.existsSync(S.paths(repoRoot).stop);
  const remainingMs = Date.parse(state.stop_at) - Date.now();
  return { state, counts, alive, pid, stopRequested, remainingMs };
}

function render(repoRoot, status) {
  const { state, counts, alive, pid, stopRequested, remainingMs } = status;
  const out = [];
  const total = Object.keys(state.tasks).length;

  const liveness = alive
    ? `running (pid ${pid})`
    : state.status === 'complete' || state.status === 'stopped'
      ? `finished — ${state.stop_reason ?? state.status}`
      : 'NOT running — the process is gone but the run was never marked finished';

  out.push(`Overnight run on ${state.branch}`);
  out.push(`  ${liveness}`);
  out.push(`  ${counts.done}/${total} done · ${counts.failed} failed · ${counts.blocked} blocked · ${counts.skipped} skipped · ${counts.pending} pending`);
  out.push(`  started ${new Date(state.started_at).toLocaleString()}`);
  if (remainingMs > 0 && alive) {
    const hours = Math.floor(remainingMs / 3_600_000);
    const minutes = Math.round((remainingMs % 3_600_000) / 60_000);
    out.push(`  stops by ${new Date(state.stop_at).toLocaleString()} (${hours}h ${minutes}m left)`);
  }
  if (stopRequested) out.push('  a stop has been requested; it will finish the current task and then exit');
  out.push('');

  for (const task of Object.values(state.tasks)) {
    const symbol = SYMBOL[task.status] ?? '?';
    const detail = [];
    if (task.status === 'done' && task.commit) detail.push(task.commit.slice(0, 8));
    if (task.attempts) detail.push(`${task.attempts} attempt${task.attempts === 1 ? '' : 's'}`);
    if (task.reason) detail.push(task.reason.slice(0, 90));
    out.push(`  ${symbol} ${task.id.padEnd(6)} ${task.title}${detail.length ? `  (${detail.join(', ')})` : ''}`);
  }
  out.push('');

  const waits = state.events.filter((e) => e.kind === 'usage_limit');
  if (waits.length) {
    const last = waits[waits.length - 1];
    out.push(`  paused for usage limits ${waits.length} time(s); most recently until ${new Date(last.until).toLocaleString()}`);
    out.push('');
  }

  const logFile = S.paths(repoRoot).log;
  if (fs.existsSync(logFile)) {
    const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-8);
    out.push('  recent log:');
    for (const line of tail) out.push(`    ${line}`);
    out.push('');
  }

  if (state.status === 'complete' || state.status === 'stopped') {
    const report = S.paths(repoRoot).report;
    if (fs.existsSync(report)) out.push(`  report: ${path.relative(repoRoot, report)}`);
  }

  return out.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  let repoRoot = process.cwd();
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repoRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--json') asJson = true;
  }
  if (git.isGitRepo(repoRoot)) repoRoot = git.repoRootOf(repoRoot) ?? repoRoot;

  let status = null;
  try {
    status = collectStatus(repoRoot);
  } catch (error) {
    console.log(`Could not read the run state: ${error.message}`);
    process.exit(0);
  }

  if (!status) {
    console.log('No overnight run has been started in this repository. Use /overnight:plan then /overnight:start.');
    process.exit(0);
  }
  console.log(asJson ? JSON.stringify(status, null, 2) : render(repoRoot, status));
}

export default { collectStatus };
