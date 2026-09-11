#!/usr/bin/env node
/**
 * fake-claude.mjs — a deterministic stand-in for `claude -p`, used only by selftest.mjs.
 *
 * The runner's hard parts are the failure paths: a worker that cheats, a reviewer that
 * rejects, the same error three times, a usage limit at 3am, a process that dies mid-task.
 * None of those can be triggered on demand against the real CLI, so the loop is tested
 * against this stub, which reproduces every one of them exactly and for free.
 *
 * Scenarios come from the JSON file named by OVERNIGHT_FAKE_SCRIPT:
 *
 *   {
 *     "T1": {
 *       "worker":   [ { "act": "edit", "files": { "src/a.js": "..." }, "status": "completed" } ],
 *       "reviewer": [ { "verdict": "pass" } ]
 *     }
 *   }
 *
 * One entry per attempt; the last entry repeats if there are more attempts than entries.
 * `act` may be edit (default), usage_limit, crash, hang, or nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let directive = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-p' || argv[i] === '--print') directive = argv[i + 1] ?? '';
}

const scriptPath = process.env.OVERNIGHT_FAKE_SCRIPT;
const script = scriptPath && fs.existsSync(scriptPath) ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : {};
const counterFile = process.env.OVERNIGHT_FAKE_COUNTERS || path.join(process.env.TMPDIR || '/tmp', 'overnight-fake-counters.json');

function readCounters() {
  try {
    return JSON.parse(fs.readFileSync(counterFile, 'utf8'));
  } catch {
    return {};
  }
}

function bumpCounter(key) {
  const counters = readCounters();
  counters[key] = (counters[key] ?? 0) + 1;
  fs.writeFileSync(counterFile, JSON.stringify(counters));
  return counters[key];
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function result({ structured, text, isError = false, subtype = 'success' }) {
  emit({
    type: 'result',
    subtype,
    is_error: isError,
    duration_ms: 10,
    num_turns: 1,
    result: text ?? JSON.stringify(structured ?? {}),
    structured_output: structured ?? null,
    session_id: 'fake-session',
    total_cost_usd: 0,
  });
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const context = Buffer.concat(chunks).toString('utf8');

  const isReviewer = /^# Review of task/m.test(context) || /structured verdict/i.test(directive);
  const isNarrator = /at most 120 words/i.test(directive);

  if (isNarrator) {
    result({ structured: { summary: 'Stub narrative for the self-test run.' } });
    return;
  }

  const taskId = (context.match(/^# (?:Review of task |Task )([A-Za-z0-9._-]+)/m) ?? [])[1];
  const role = isReviewer ? 'reviewer' : 'worker';
  const entries = script[taskId]?.[role] ?? [];
  const attempt = bumpCounter(`${taskId}:${role}`);
  const step = entries.length ? entries[Math.min(attempt - 1, entries.length - 1)] : {};

  if (step.act === 'usage_limit') {
    result({
      text: step.message ?? 'Claude usage limit reached. Your limit will reset at 7am.',
      isError: true,
      subtype: 'error_during_execution',
    });
    return;
  }

  if (step.act === 'crash') {
    process.stderr.write(`${step.message ?? 'simulated crash: ENOSPC writing to disk'}\n`);
    process.exit(step.code ?? 1);
  }

  if (step.act === 'hang') {
    await new Promise((resolve) => setTimeout(resolve, step.ms ?? 600_000));
    result({ structured: { status: 'completed', summary: 'woke up', assumptions: [], questions: [], files_changed: [] } });
    return;
  }

  if (role === 'reviewer') {
    result({
      structured: {
        verdict: step.verdict ?? 'pass',
        reasons: step.reasons ?? [step.verdict === 'fail' ? 'The change does not achieve the stated goal.' : 'The change achieves the goal, stays in scope, and the tests were not weakened.'],
        achieved_goal: step.verdict !== 'fail',
        stayed_in_scope: step.stayed_in_scope ?? true,
        obtained_honestly: step.obtained_honestly ?? true,
        dishonesty_detail: step.dishonesty_detail ?? '',
        assumptions: step.assumptions ?? [],
        questions: step.questions ?? [],
        suggested_fix: step.suggested_fix ?? '',
      },
    });
    return;
  }

  // Worker: actually change the tree so the runner has something real to verify.
  const written = [];
  for (const [relative, contents] of Object.entries(step.files ?? {})) {
    const destination = path.resolve(process.cwd(), relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
    written.push(relative);
  }
  for (const relative of step.delete ?? []) {
    const destination = path.resolve(process.cwd(), relative);
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination);
      written.push(relative);
    }
  }

  result({
    structured: {
      status: step.status ?? 'completed',
      summary: step.summary ?? `Stub worker handled ${taskId}.`,
      assumptions: step.assumptions ?? [],
      questions: step.questions ?? [],
      files_changed: written,
      acceptance_run: step.acceptance_run ?? [],
      notes: step.notes ?? '',
    },
  });
}

main().catch((error) => {
  process.stderr.write(`fake-claude failed: ${error.message}\n`);
  process.exit(1);
});
