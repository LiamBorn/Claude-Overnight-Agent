/**
 * state.mjs — the run's durable memory.
 *
 * Everything the runner needs to resume after a crash, a disconnect, a usage-limit
 * pause, or a laptop going to sleep lives in .overnight/state.json. It is written by
 * the supervisor, never by a worker, and every write is atomic: temp file then rename,
 * so a process killed mid-write cannot leave a truncated file behind.
 */

import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;

export const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
};

/** Statuses a task will never leave. */
export const TERMINAL = new Set([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.BLOCKED,
  TASK_STATUS.SKIPPED,
]);

export function overnightDir(repoRoot) {
  return path.join(repoRoot, '.overnight');
}

export function paths(repoRoot) {
  const dir = overnightDir(repoRoot);
  return {
    dir,
    state: path.join(dir, 'state.json'),
    log: path.join(dir, 'log.md'),
    report: path.join(dir, 'MORNING_REPORT.md'),
    dryRun: path.join(dir, 'DRY_RUN.md'),
    stop: path.join(dir, 'STOP'),
    pid: path.join(dir, 'runner.pid'),
    out: path.join(dir, 'runner.out'),
    failed: path.join(dir, 'failed'),
    transcripts: path.join(dir, 'transcripts'),
  };
}

export function ensureDirs(repoRoot) {
  const p = paths(repoRoot);
  fs.mkdirSync(p.failed, { recursive: true });
  fs.mkdirSync(p.transcripts, { recursive: true });
  return p;
}

export function createState({ repoRoot, planPath, planHash, branch, baseBranch, baseCommit, settings, tasks, stopAtMs }) {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    run_id: now.replace(/[:.]/g, '-'),
    repo_root: repoRoot,
    plan_path: planPath,
    plan_hash: planHash,
    branch,
    base_branch: baseBranch,
    base_commit: baseCommit,
    started_at: now,
    updated_at: now,
    finished_at: null,
    stop_at: new Date(stopAtMs).toISOString(),
    settings,
    baseline: null,
    status: 'running',
    stop_reason: null,
    consecutive_failures: 0,
    tasks: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        {
          id: task.id,
          title: task.title,
          priority: task.priority,
          depends_on: task.depends_on,
          max_attempts: task.max_attempts,
          scope: task.scope,
          status: TASK_STATUS.PENDING,
          attempts: 0,
          attempt_log: [],
          base_commit: null,
          commit: null,
          reason: null,
          assumptions: [],
          questions: [],
          scope_violations: [],
          cheat_flags: [],
          started_at: null,
          finished_at: null,
        },
      ]),
    ),
    events: [],
  };
}

export function readState(repoRoot) {
  const file = paths(repoRoot).state;
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return null;
  const state = JSON.parse(raw);
  if (state.version !== STATE_VERSION) {
    throw new Error(
      `.overnight/state.json was written by state format v${state.version}; this build understands v${STATE_VERSION}. Move it aside to start fresh.`,
    );
  }
  return state;
}

/** Atomic: write a sibling temp file, fsync, then rename over the target. */
export function writeState(repoRoot, state) {
  const { dir, state: file } = paths(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  state.updated_at = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tmp, file);
  return state;
}

export function recordEvent(state, kind, detail, extra = {}) {
  state.events.push({ at: new Date().toISOString(), kind, detail, ...extra });
  return state;
}

/** Append a timestamped line to the human-readable run log. */
export function appendLog(repoRoot, message, { heading = false } = {}) {
  const { dir, log } = paths(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = heading ? `\n## ${stamp} — ${message}\n` : `- \`${stamp}\` ${message}\n`;
  fs.appendFileSync(log, line);
}

/**
 * A crashed run leaves a task marked `running`. That attempt really did happen and
 * really did fail, so it counts: a task that reliably kills the process must not be
 * retried forever. Record it and put the task back in the queue.
 */
export function reconcileAfterCrash(state) {
  const recovered = [];
  for (const task of Object.values(state.tasks)) {
    if (task.status === TASK_STATUS.RUNNING) {
      task.status = TASK_STATUS.PENDING;
      task.attempts += 1;
      task.attempt_log.push({
        n: task.attempts,
        started_at: task.started_at,
        ended_at: new Date().toISOString(),
        outcome: 'crashed',
        detail: 'The runner process died while this task was in flight.',
        error_fingerprint: 'runner-crash',
      });
      recovered.push(task.id);
    }
  }
  return recovered;
}

export function countByStatus(state) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const task of Object.values(state.tasks)) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

export default {
  STATE_VERSION,
  TASK_STATUS,
  TERMINAL,
  paths,
  ensureDirs,
  createState,
  readState,
  writeState,
  recordEvent,
  appendLog,
  reconcileAfterCrash,
  countByStatus,
};
