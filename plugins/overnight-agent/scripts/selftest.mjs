#!/usr/bin/env node
/**
 * selftest.mjs — proves the parts that only matter when something goes wrong.
 *
 * A happy path is easy to demonstrate and tells you almost nothing. What decides whether
 * this plugin is safe to run while asleep is what it does when a worker cheats, a reviewer
 * rejects, the same error repeats, a usage limit lands at 3am, or the process dies
 * mid-task. None of those can be produced on demand from the real CLI, so the loop is
 * driven here by testing/fake-claude.mjs, which reproduces each one exactly and for free.
 *
 * Usage: node selftest.mjs [--keep]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parsePlan, parseRestrictedYaml, PlanError } from './planparse.mjs';
import { validatePlan, topologicalOrder } from './validate.mjs';
import {
  parseResetTime, errorFingerprint, detectCheatSignals, scopeViolations, classifyRun, OUTCOME,
} from './classify.mjs';
import { resolveSettings, nextOccurrence } from './config.mjs';
import { versionAtLeast } from './preflight.mjs';
import * as S from './state.mjs';
import * as git from './gitops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const RUNNER = path.join(HERE, 'runner.mjs');
const FAKE = path.join(PLUGIN_ROOT, 'testing', 'fake-claude.mjs');
const KEEP = process.argv.includes('--keep');

let passed = 0;
const failures = [];
const workspaces = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

function throws(name, fn, pattern) {
  try {
    fn();
    check(name, false, 'expected it to throw, but it returned');
  } catch (error) {
    check(name, pattern ? pattern.test(error.message) : true, pattern ? `message was "${error.message}"` : '');
  }
}

// ---------------------------------------------------------------------------
// Unit: the plan parser
// ---------------------------------------------------------------------------

function testParser() {
  section('Plan parser');

  const yaml = parseRestrictedYaml([
    'id: T1',
    'priority: 2',
    'done: true',
    'ratio: 1.5',
    'nothing: null',
    'depends_on: []',
    'inline: [a, b]',
    'scope:',
    '  - src/a.js',
    '  - src/b.js',
    'acceptance:',
    '  - command: npm test',
    '    expect: exit_zero',
    '  - command: "echo hi # not a comment"',
    'quoted: "a: b"',
  ].join('\n'));

  check('scalars keep their types', yaml.id === 'T1' && yaml.priority === 2 && yaml.done === true && yaml.ratio === 1.5 && yaml.nothing === null);
  check('empty and inline lists parse', Array.isArray(yaml.depends_on) && yaml.depends_on.length === 0 && yaml.inline.length === 2);
  check('block list of scalars parses', yaml.scope.length === 2 && yaml.scope[1] === 'src/b.js');
  check('block list of maps parses', yaml.acceptance[0].command === 'npm test' && yaml.acceptance[0].expect === 'exit_zero');
  check('a # inside quotes is not a comment', yaml.acceptance[1].command === 'echo hi # not a comment');
  check('a colon inside quotes is not a key separator', yaml.quoted === 'a: b');

  throws('tabs are rejected', () => parseRestrictedYaml('id:\tT1'), /tab/i);
  throws('duplicate keys are rejected', () => parseRestrictedYaml('id: a\nid: b'), /duplicate/i);
  throws('deep nesting is rejected rather than guessed at', () => parseRestrictedYaml('a:\n  - b:\n      c: 1'), /nesting|not supported/i);
  throws('inline maps are rejected', () => parseRestrictedYaml('a: {b: 1}'), /inline map/i);
  throws('a nested mapping under a key is rejected', () => parseRestrictedYaml('a:\n  b: 1'), /list|not supported/i);

  const plan = parsePlan(SAMPLE_PLAN);
  check('the plan splits into tasks', plan.tasks.length === 3, `saw ${plan.tasks.length}`);
  check('settings are read', plan.settings.max_tasks === 5);
  check('goal prose is captured', plan.tasks[0].goal.includes('values.txt'));
  check('bare-string acceptance becomes a command expecting exit 0',
    plan.tasks[0].acceptance[0].command.length > 0 && plan.tasks[0].acceptance[0].expect === 'exit_zero');
  check('a ## heading inside a fence is not a section break', plan.tasks.length === 3);
}

// ---------------------------------------------------------------------------
// Unit: validation
// ---------------------------------------------------------------------------

function testValidation() {
  section('Plan validation');

  const good = validatePlan(SAMPLE_PLAN);
  check('a well-formed plan validates', good.ok, good.errors.join('; '));
  check('execution order respects dependencies',
    good.order.indexOf('T1') < good.order.indexOf('T2'), good.order.join(','));

  const noAcceptance = validatePlan(SAMPLE_PLAN.replace(
    'acceptance:\n  - command: test "$(cat values.txt)" = "1"\n    expect: exit_zero',
    'acceptance: []',
  ));
  check('a task with no acceptance criteria is rejected',
    !noAcceptance.ok && noAcceptance.errors.some((e) => /acceptance/i.test(e)));

  const unverifiable = validatePlan(SAMPLE_PLAN.replace('- command: test "$(cat values.txt)" = "1"', '- command: looks good'));
  check('an unverifiable acceptance criterion is rejected',
    !unverifiable.ok && unverifiable.errors.some((e) => /not a command/i.test(e)));

  const needsHuman = validatePlan(SAMPLE_PLAN.replace('Set the contents of values.txt to 1.', 'Ask me which value to use, then set it.'));
  check('a task that would wait for a person is rejected',
    !needsHuman.ok && needsHuman.errors.some((e) => /nobody is awake/i.test(e)));

  const dangerous = validatePlan(SAMPLE_PLAN.replace('Set the contents of values.txt to 1.', 'Set the value and then git push the branch.'));
  check('a task that would push is rejected',
    !dangerous.ok && dangerous.errors.some((e) => /push/i.test(e)));

  const cyclic = validatePlan(SAMPLE_PLAN.replace('depends_on: []\nmax_attempts: 2\nscope:\n  - values.txt', 'depends_on: [T2]\nmax_attempts: 2\nscope:\n  - values.txt'));
  check('a dependency cycle is named, not just refused',
    !cyclic.ok && cyclic.errors.some((e) => /circular/i.test(e)), cyclic.errors.join('; '));

  const missingDep = validatePlan(SAMPLE_PLAN.replace('depends_on: [T1]', 'depends_on: [T9]'));
  check('a dependency on a task that does not exist is rejected',
    !missingDep.ok && missingDep.errors.some((e) => /not a task in this plan/i.test(e)));

  const { cycles } = topologicalOrder([
    { id: 'a', depends_on: ['b'], priority: 1 },
    { id: 'b', depends_on: ['a'], priority: 1 },
  ]);
  check('topological order reports the cycle members', cycles.length === 1 && cycles[0].length === 2);
}

// ---------------------------------------------------------------------------
// Unit: classification
// ---------------------------------------------------------------------------

function testClassification() {
  section('Result classification');

  const limit = classifyRun({ status: 0, stdout: JSON.stringify({ type: 'result', result: 'Claude usage limit reached. Your limit will reset at 3am.' }), stderr: '' });
  check('a usage limit on a zero exit is still a usage limit', limit.outcome === OUTCOME.USAGE_LIMIT);
  check('the reset time is read out of the message', typeof limit.resetAt === 'number' && limit.resetAt > Date.now());

  const timeout = classifyRun({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true });
  check('a killed process is a timeout, not a crash', timeout.outcome === OUTCOME.TIMEOUT);

  const maxTurns = classifyRun({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns' }), stderr: '' });
  check('running out of turns is its own outcome', maxTurns.outcome === OUTCOME.MAX_TURNS);

  const auth = classifyRun({ status: 1, stdout: '', stderr: 'Invalid API key · Please run /login' });
  check('an auth failure is distinguished from an ordinary error', auth.outcome === OUTCOME.AUTH);

  check('an ISO reset time parses', parseResetTime('limit will reset at 2030-01-01T00:00:00Z') === Date.parse('2030-01-01T00:00:00Z'));
  check('a relative retry hint parses', parseResetTime('please retry in 5 minutes') > Date.now() + 4 * 60_000);
  check('no reset information yields null so the caller backs off', parseResetTime('something else entirely') === null);

  const a = errorFingerprint('Error at /Users/x/proj/src/a.js:42 after 3.2s — ECONNREFUSED');
  const b = errorFingerprint('Error at /Users/y/other/src/a.js:99 after 8.7s — ECONNREFUSED');
  const c = errorFingerprint('Error: something completely different');
  check('the same failure in different runs fingerprints identically', a === b);
  check('a different failure fingerprints differently', a !== c);

  const cheats = detectCheatSignals([
    '--- a/test/thing.test.js',
    '+++ b/test/thing.test.js',
    '+it.skip("does the thing", () => {',
    '+expect(true).toBe(true)',
    '+++ b/jest.config.js',
    '+// @ts-ignore',
  ].join('\n'));
  check('skipped tests are detected', cheats.some((f) => /skipped/i.test(f)));
  check('tautological assertions are detected', cheats.some((f) => /tautological/i.test(f)));
  check('edits to the test runner config are detected', cheats.some((f) => /configuration/i.test(f)));
  check('type-check suppression is detected', cheats.some((f) => /ts-ignore/i.test(f)));
  check('a clean diff produces no flags', detectCheatSignals('+const x = 1;').length === 0);

  check('files outside scope are reported',
    scopeViolations(['src/a.js', 'other/b.js'], ['src/']).join() === 'other/b.js');
  check('a directory in scope covers files beneath it',
    scopeViolations(['src/deep/a.js'], ['src']).length === 0);
  check('glob scope works', scopeViolations(['src/a.ts', 'src/b.js'], ['src/*.ts']).join() === 'src/b.js');
  check('an empty scope means nothing is out of scope', scopeViolations(['anything'], []).length === 0);
}

function testConfigAndState() {
  section('Settings and state');

  const bad = resolveSettings({ planSettings: { stop_at: '25:00', max_tasks: -1, on_failure: 'nuke' } });
  check('an impossible stop time is rejected', bad.errors.some((e) => /stop_at/.test(e)));
  check('a negative task limit is rejected', bad.errors.some((e) => /max_tasks/.test(e)));
  check('an unknown on_failure mode is rejected', bad.errors.some((e) => /on_failure/.test(e)));
  check('a mainline branch prefix is rejected', resolveSettings({ planSettings: { branch_prefix: 'main' } }).errors.length > 0);
  check('unknown settings are surfaced, not silently ignored',
    resolveSettings({ planSettings: { typo_here: 1 } }).unknown.includes('typo_here'));

  const morning = nextOccurrence('07:00', new Date('2026-09-11T23:30:00'));
  check('stop time rolls to tomorrow when it has already passed today',
    new Date(morning).getDate() === 12 && new Date(morning).getHours() === 7);

  check('a newer Claude Code version is detected', versionAtLeast('2.1.259 (Claude Code)', '2.1.259'));
  check('an older Claude Code version is detected', !versionAtLeast('2.1.252 (Claude Code)', '2.1.259'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-state-'));
  workspaces.push(dir);
  const state = S.createState({
    repoRoot: dir, planPath: 'p.md', planHash: 'h', branch: 'overnight/x', baseBranch: 'main',
    baseCommit: 'abc', settings: { stop_at: '07:00' }, tasks: [{ id: 'T1', title: 't', priority: 1, depends_on: [], max_attempts: 2, scope: [] }],
    stopAtMs: Date.now() + 3600_000,
  });
  S.writeState(dir, state);
  check('state round-trips through the atomic write', S.readState(dir).tasks.T1.id === 'T1');
  check('the write leaves no temp file behind',
    fs.readdirSync(path.join(dir, '.overnight')).every((f) => !f.endsWith('.tmp')));

  state.tasks.T1.status = S.TASK_STATUS.RUNNING;
  const recovered = S.reconcileAfterCrash(state);
  check('a task interrupted by a crash is queued again', recovered.includes('T1') && state.tasks.T1.status === 'pending');
  check('the crashed attempt is counted, so a task that kills the runner cannot loop forever',
    state.tasks.T1.attempts === 1 && state.tasks.T1.attempt_log[0].outcome === 'crashed');
}

// ---------------------------------------------------------------------------
// Integration: the loop, driven by the stub
// ---------------------------------------------------------------------------

function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `overnight-${name}-`));
  workspaces.push(dir);
  const run = (args, options = {}) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', ...options });
  run(['init', '--initial-branch=main']);
  run(['config', 'user.email', 'selftest@example.com']);
  run(['config', 'user.name', 'Overnight Selftest']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'values.txt'), '0\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  run(['add', '-A']);
  run(['commit', '-m', 'initial']);
  return dir;
}

function runRunner(repo, script, extraArgs = []) {
  // The stub's own files live outside the repo so they cannot dirty the tree under test.
  const sidecar = `${repo}-stub`;
  fs.mkdirSync(sidecar, { recursive: true });
  if (!workspaces.includes(sidecar)) workspaces.push(sidecar);
  const scriptFile = path.join(sidecar, 'fake-script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script, null, 2));
  const counters = path.join(sidecar, 'fake-counters.json');
  const result = spawnSync('node', [RUNNER, '--repo', repo, ...extraArgs], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      OVERNIGHT_CLAUDE_BIN: FAKE,
      OVERNIGHT_FAKE_SCRIPT: scriptFile,
      OVERNIGHT_FAKE_COUNTERS: counters,
    },
  });
  return result;
}

const PLAN_HEADER = (settings) => `# Selftest plan

## Settings

\`\`\`yaml
${settings}
\`\`\`
`;

function task({ id, title, goal, acceptance, depends = '[]', attempts = 2, scope = 'values.txt', priority = 1 }) {
  return `
## Task: ${id} — ${title}

\`\`\`yaml
id: ${id}
priority: ${priority}
depends_on: ${depends}
max_attempts: ${attempts}
scope:
  - ${scope}
acceptance:
  - command: ${acceptance}
    expect: exit_zero
\`\`\`

### Goal

${goal}
`;
}

function testHappyPath() {
  section('Integration: a clean run');
  const repo = makeRepo('happy');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"' }) +
    task({ id: 'T2', title: 'Add a marker file', goal: 'Create marker.txt containing the word ready, which the release checklist looks for.', acceptance: 'grep -q ready marker.txt', depends: '[T1]', scope: 'marker.txt' }));

  const result = runRunner(repo, {
    T1: { worker: [{ files: { 'values.txt': '1' } }], reviewer: [{ verdict: 'pass' }] },
    T2: { worker: [{ files: { 'marker.txt': 'ready\n' } }], reviewer: [{ verdict: 'pass' }] },
  });

  const state = S.readState(repo);
  check('the run exits cleanly', result.status === 0, result.stderr?.slice(0, 300));
  check('both tasks are done', state.tasks.T1.status === 'done' && state.tasks.T2.status === 'done');
  check('each completed task produced a commit', Boolean(state.tasks.T1.commit) && Boolean(state.tasks.T2.commit));
  check('work landed on the overnight branch', /^overnight\//.test(git.currentBranch(repo)));
  check('main was never touched',
    spawnSync('git', ['log', '--oneline', 'main'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').length === 1);
  check('two commits exist on the branch', git.shortLog(repo, state.base_commit, state.branch).length === 2);
  check('the commit message records what verified it',
    spawnSync('git', ['log', '-1', '--format=%B', state.tasks.T1.commit], { cwd: repo, encoding: 'utf8' }).stdout.includes('Verified by'));
  check('the morning report is written', fs.existsSync(S.paths(repo).report));
  check('.overnight stays out of git', !git.changedFiles(repo, state.base_commit).some((f) => f.startsWith('.overnight')));

  const report = fs.readFileSync(S.paths(repo).report, 'utf8');
  check('the report states the score', /2 of 2 tasks completed/.test(report));
  check('the report explains how to undo everything', /branch -D/.test(report));
}

function testReviewerRejection() {
  section('Integration: the reviewer rejects, then the retry succeeds');
  const repo = makeRepo('review');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"' }));

  const result = runRunner(repo, {
    T1: {
      worker: [
        { files: { 'values.txt': '1', 'sneaky.txt': 'out of scope' }, summary: 'first try' },
        { files: { 'values.txt': '1' }, summary: 'second try' },
      ],
      reviewer: [
        { verdict: 'fail', reasons: ['values.txt is right but sneaky.txt is unrelated to the goal.'], suggested_fix: 'Do not create unrelated files.' },
        { verdict: 'pass' },
      ],
    },
  });

  const state = S.readState(repo);
  check('the run exits cleanly', result.status === 0, result.stderr?.slice(0, 300));
  check('passing acceptance commands do not make a task done on their own', state.tasks.T1.attempts === 2);
  check('the task finished only once the reviewer agreed', state.tasks.T1.status === 'done');
  check('the rejected attempt is preserved as a patch',
    fs.readdirSync(S.paths(repo).failed).some((f) => f.startsWith('T1-attempt1')));
  check('the rejected attempt did not reach the branch',
    !fs.existsSync(path.join(repo, 'sneaky.txt')));
  check('the out-of-scope file was recorded on the attempt',
    state.tasks.T1.attempt_log[0].scope_violations.includes('sneaky.txt'));
  check('only one commit was made', git.shortLog(repo, state.base_commit, state.branch).length === 1);
}

function testStuckAndDependents() {
  section('Integration: the same error three times blocks the task');
  const repo = makeRepo('stuck');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nstuck_threshold: 3\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 2', goal: 'Set the contents of values.txt to the single character 2, which the deployment script expects.', acceptance: 'test "$(cat values.txt)" = "2"', attempts: 6 }) +
    task({ id: 'T2', title: 'Depends on the value', goal: 'Write dependent.txt once the value is correct, so the checklist can be completed.', acceptance: 'test -f dependent.txt', depends: '[T1]', scope: 'dependent.txt' }));

  const result = runRunner(repo, {
    T1: { worker: [{ files: { 'values.txt': '9' } }], reviewer: [{ verdict: 'pass' }] },
    T2: { worker: [{ files: { 'dependent.txt': 'x' } }], reviewer: [{ verdict: 'pass' }] },
  });

  const state = S.readState(repo);
  check('the run exits cleanly', result.status === 0, result.stderr?.slice(0, 300));
  check('the task stops at the stuck threshold rather than using all its attempts',
    state.tasks.T1.attempts === 3, `attempts=${state.tasks.T1.attempts} of max 6`);
  check('the task is marked blocked', state.tasks.T1.status === 'blocked');
  check('the reason says it repeated the same error', /same error/i.test(state.tasks.T1.reason ?? ''));
  check('the dependent task is skipped, not failed', state.tasks.T2.status === 'skipped');
  check('the skip reason names the blocker', /T1/.test(state.tasks.T2.reason ?? ''));
  check('nothing was committed', git.shortLog(repo, state.base_commit, state.branch).length === 0);
  check('the tree was restored to its starting state', fs.readFileSync(path.join(repo, 'values.txt'), 'utf8').trim() === '0');

  const report = fs.readFileSync(S.paths(repo).report, 'utf8');
  check('the report explains the blocked task', /Blocked/.test(report) && /T1/.test(report));
  check('the report points at the saved patch', /\.overnight\/failed\/T1-attempt/.test(report));
}

function testUsageLimit() {
  section('Integration: a usage limit pauses and resumes');
  const repo = makeRepo('limit');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nlimit_backoff_start_seconds: 1\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"' }));

  const started = Date.now();
  const result = runRunner(repo, {
    T1: {
      worker: [
        { act: 'usage_limit', message: 'Claude usage limit reached. Please retry in 1 seconds.' },
        { files: { 'values.txt': '1' } },
      ],
      reviewer: [{ verdict: 'pass' }],
    },
  });

  const state = S.readState(repo);
  check('the run exits cleanly', result.status === 0, result.stderr?.slice(0, 300));
  check('the task completes after the wait', state.tasks.T1.status === 'done');
  check('hitting a limit does not spend an attempt', state.tasks.T1.attempts === 1, `attempts=${state.tasks.T1.attempts}`);
  check('the pause is recorded for the report', state.events.some((e) => e.kind === 'usage_limit'));
  check('it actually waited', Date.now() - started >= 1000);
  check('the report mentions the pause', /paused .* usage limits/i.test(fs.readFileSync(S.paths(repo).report, 'utf8')));
}

function testStopSentinel() {
  section('Integration: a stop request is honoured between tasks');
  const repo = makeRepo('stop');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"' }) +
    task({ id: 'T2', title: 'Add a marker file', goal: 'Create marker.txt containing the word ready, which the release checklist looks for.', acceptance: 'grep -q ready marker.txt', scope: 'marker.txt', priority: 2 }));

  fs.mkdirSync(path.join(repo, '.overnight'), { recursive: true });
  fs.writeFileSync(S.paths(repo).stop, 'requested by the selftest\n');

  const result = runRunner(repo, {
    T1: { worker: [{ files: { 'values.txt': '1' } }], reviewer: [{ verdict: 'pass' }] },
    T2: { worker: [{ files: { 'marker.txt': 'ready\n' } }], reviewer: [{ verdict: 'pass' }] },
  });

  const state = S.readState(repo);
  check('the run exits cleanly', result.status === 0, result.stderr?.slice(0, 300));
  check('no task was started after the stop request', state.tasks.T1.status === 'pending' && state.tasks.T2.status === 'pending');
  check('the stop reason is recorded honestly', /asked it to stop/i.test(state.stop_reason ?? ''));
  check('a report is still written', fs.existsSync(S.paths(repo).report));
  check('the stop sentinel is cleared so the next run is not blocked', !fs.existsSync(S.paths(repo).stop));
}

function testResumeAfterInterruption() {
  section('Integration: resuming an interrupted run');
  const repo = makeRepo('resume');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"' }) +
    task({ id: 'T2', title: 'Add a marker file', goal: 'Create marker.txt containing the word ready, which the release checklist looks for.', acceptance: 'grep -q ready marker.txt', scope: 'marker.txt', priority: 2 }));

  const script = {
    T1: { worker: [{ files: { 'values.txt': '1' } }], reviewer: [{ verdict: 'pass' }] },
    T2: { worker: [{ files: { 'marker.txt': 'ready\n' } }], reviewer: [{ verdict: 'pass' }] },
  };

  // First run finishes T1, then stop.
  fs.mkdirSync(path.join(repo, '.overnight'), { recursive: true });
  runRunner(repo, script, []);
  const first = S.readState(repo);
  check('the first run completed both tasks', first.tasks.T1.status === 'done' && first.tasks.T2.status === 'done');

  // Now simulate a crash mid-T2: rewind the state to "running" and re-run with --resume.
  const crashed = S.readState(repo);
  crashed.status = 'running';
  crashed.finished_at = null;
  crashed.stop_reason = null;
  crashed.tasks.T2.status = 'running';
  crashed.tasks.T2.commit = null;
  crashed.tasks.T2.attempts = 0;
  crashed.tasks.T2.attempt_log = [];
  S.writeState(repo, crashed);
  spawnSync('git', ['reset', '--hard', crashed.tasks.T2.base_commit], { cwd: repo });
  fs.rmSync(path.join(`${repo}-stub`, 'fake-counters.json'), { force: true });

  const result = runRunner(repo, script, ['--resume']);
  const resumed = S.readState(repo);
  check('the resumed run exits cleanly', result.status === 0, result.stderr?.slice(0, 400));
  check('the completed task is not redone', resumed.tasks.T1.attempts === first.tasks.T1.attempts);
  check('the interrupted task is finished', resumed.tasks.T2.status === 'done');
  check('the interrupted attempt was counted against the retry budget',
    resumed.tasks.T2.attempt_log.some((a) => a.outcome === 'crashed'));
  check('the resume stayed on the same branch', resumed.branch === first.branch);
}

function testWorkerCrash() {
  section('Integration: a worker process that dies');
  const repo = makeRepo('crash');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"\nnarrative_summary: false') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"', attempts: 2 }));

  const result = runRunner(repo, {
    T1: {
      worker: [{ act: 'crash', message: 'simulated: out of disk' }, { files: { 'values.txt': '1' } }],
      reviewer: [{ verdict: 'pass' }],
    },
  });

  const state = S.readState(repo);
  check('the run survives a dead worker', result.status === 0, result.stderr?.slice(0, 300));
  check('the crash is recorded as a failed attempt', state.tasks.T1.attempt_log[0].outcome === 'error');
  check('the retry succeeds', state.tasks.T1.status === 'done' && state.tasks.T1.attempts === 2);
}

function testDryRun() {
  section('Integration: dry run changes nothing');
  const repo = makeRepo('dry');
  fs.writeFileSync(path.join(repo, 'OVERNIGHT_PLAN.md'),
    PLAN_HEADER('max_tasks: 5\nstop_at: "23:59"') +
    task({ id: 'T1', title: 'Set the value to 1', goal: 'Set the contents of values.txt to the single character 1 so downstream work can rely on it.', acceptance: 'test "$(cat values.txt)" = "1"' }));

  const before = git.headCommit(repo);
  const branchesBefore = spawnSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' }).stdout;
  const result = runRunner(repo, {}, ['--dry-run']);

  check('the dry run exits cleanly', result.status === 0, result.stderr?.slice(0, 300));
  check('it reports what it would do', /would create branch/i.test(result.stdout));
  check('it names the acceptance command it would run', /test "\$\(cat values\.txt\)"/.test(result.stdout));
  check('it lists what is blocked for the whole run', /Pushing, merging/i.test(result.stdout));
  check('no commit was made', git.headCommit(repo) === before);
  check('no branch was created', spawnSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' }).stdout === branchesBefore);
  check('no run state was created', !fs.existsSync(S.paths(repo).state));
  check('the working tree is untouched apart from the plan the test just wrote',
    git.dirtyFilesExcept(repo, ['OVERNIGHT_PLAN.md']).length === 0,
    git.dirtyFilesExcept(repo, ['OVERNIGHT_PLAN.md']).join(','));
}

function testGuardHook() {
  section('The guard hook');

  const callGuard = (payload, env = {}) => {
    const result = spawnSync('node', [path.join(HERE, 'guard.mjs')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, OVERNIGHT_RUN: '1', OVERNIGHT_REPO_ROOT: '/tmp/fake-repo', ...env },
    });
    const decision = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision : 'allow';
    return { decision, reason: result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason : '' };
  };
  const bash = (command, env) => callGuard({ tool_name: 'Bash', tool_input: { command } }, env);

  // The single most important property: it is inert in ordinary sessions.
  const daytime = spawnSync('node', [path.join(HERE, 'guard.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
    encoding: 'utf8',
    env: { ...process.env, OVERNIGHT_RUN: '' },
  });
  check('it does nothing at all in a normal session', daytime.stdout.trim() === '' && daytime.status === 0);

  check('a plain push is blocked', bash('git push origin main').decision === 'deny');
  check('a push hidden behind -C is blocked', bash('git -C . push origin main').decision === 'deny');
  check('a push inside sh -c is blocked', bash("sh -c 'git push --force'").decision === 'deny');
  check('a push after an env assignment is blocked', bash('GIT_SSH_COMMAND=x git push').decision === 'deny');
  check('switching branches is blocked', bash('git checkout main').decision === 'deny');
  check('committing is blocked, because the supervisor owns git', bash('git commit -m x').decision === 'deny');
  check('gh is blocked', bash('gh pr create').decision === 'deny');
  check('starting another claude session is blocked', bash('claude -p "do something"').decision === 'deny');
  check('deploying is blocked', bash('vercel deploy --prod').decision === 'deny');
  check('sudo is blocked', bash('sudo rm -rf /var').decision === 'deny');
  check('reading a .env file is blocked', bash('cat .env').decision === 'deny');
  check('the network is blocked by default', bash('curl https://example.com').decision === 'deny');
  check('the network is allowed when the plan opts in',
    bash('curl https://example.com', { OVERNIGHT_ALLOW_NETWORK: '1' }).decision !== 'deny');
  check('installing packages is blocked by default', bash('npm install left-pad').decision === 'deny');
  check('installing is allowed when the plan opts in',
    bash('npm install left-pad', { OVERNIGHT_ALLOW_INSTALL: '1' }).decision !== 'deny');

  check('running the tests is allowed', bash('npm test -- src/foo').decision !== 'deny');
  check('reading history is allowed', bash('git log --oneline -5').decision !== 'deny');

  check('writing outside the project is blocked',
    callGuard({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } }).decision === 'deny');
  check('writing a key file is blocked',
    callGuard({ tool_name: 'Edit', tool_input: { file_path: 'config/server.key' } }).decision === 'deny');
  check('writing inside .git is blocked',
    callGuard({ tool_name: 'Write', tool_input: { file_path: '.git/config' } }).decision === 'deny');
  check('an ordinary source edit is allowed',
    callGuard({ tool_name: 'Edit', tool_input: { file_path: 'src/index.js' } }).decision !== 'deny');

  const broken = spawnSync('node', [path.join(HERE, 'guard.mjs')], {
    input: 'not json at all',
    encoding: 'utf8',
    env: { ...process.env, OVERNIGHT_RUN: '1' },
  });
  check('it fails closed when it cannot understand the call',
    JSON.parse(broken.stdout).hookSpecificOutput.permissionDecision === 'deny');
}

// ---------------------------------------------------------------------------

const SAMPLE_PLAN = `# Selftest plan

## Settings

\`\`\`yaml
max_tasks: 5
stop_at: "07:00"
\`\`\`

## Task: T1 — Set the value

\`\`\`yaml
id: T1
priority: 1
depends_on: []
max_attempts: 2
scope:
  - values.txt
acceptance:
  - command: test "$(cat values.txt)" = "1"
    expect: exit_zero
\`\`\`

### Goal

Set the contents of values.txt to 1. Downstream tasks read this file and expect exactly that.

## Task: T2 — Use the value

\`\`\`yaml
id: T2
priority: 1
depends_on: [T1]
max_attempts: 2
scope:
  - marker.txt
acceptance:
  - grep -q ready marker.txt
\`\`\`

### Goal

Create marker.txt containing the word ready, once the value file is correct.

## Task: T3 — Independent work

\`\`\`yaml
id: T3
priority: 3
depends_on: []
max_attempts: 1
scope:
  - README.md
acceptance:
  - command: grep -q fixture README.md
\`\`\`

### Goal

Confirm the README still describes the fixture, which nothing else depends on.

### Notes

This example contains a fenced block with a ## heading inside it, to prove the section
splitter is fence-aware:

\`\`\`
## Not a section heading
\`\`\`
`;

// ---------------------------------------------------------------------------

testParser();
testValidation();
testClassification();
testConfigAndState();
testGuardHook();
testHappyPath();
testReviewerRejection();
testStuckAndDependents();
testUsageLimit();
testStopSentinel();
testResumeAfterInterruption();
testWorkerCrash();
testDryRun();

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write('\nFailures:\n');
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
}
if (!KEEP) {
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
} else {
  process.stdout.write(`\nWorkspaces kept:\n${workspaces.map((w) => `  ${w}`).join('\n')}\n`);
}
process.exit(failures.length ? 1 : 0);
