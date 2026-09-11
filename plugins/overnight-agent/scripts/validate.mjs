/**
 * validate.mjs — catch the plan problems that would waste the whole night.
 *
 * Errors block the run. Warnings are shown and the run proceeds. The distinction is
 * simple: an error means the run would either misbehave or produce a result nobody
 * can trust; a warning means a human would probably have written it differently.
 *
 * Usage: node validate.mjs [--plan OVERNIGHT_PLAN.md] [--repo .] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan, PlanError } from './planparse.mjs';
import { resolveSettings, readRepoConfig } from './config.mjs';

/** Phrases that mean a human has to be awake. */
const NEEDS_HUMAN = [
  /\bask (?:me|the user|liam)\b/i,
  /\bconfirm with (?:me|the user)\b/i,
  /\bcheck with (?:me|us)\b/i,
  /\bwait for (?:my|your) (?:input|approval|answer|decision)\b/i,
  /\blet me (?:know|decide|choose)\b/i,
  /\bmy (?:preference|opinion|call)\b/i,
  /\bwe(?:'| )ll decide\b/i,
  /\bTBD\b/,
  /\bdecide together\b/i,
  /\?{3,}/,
];

/** Acceptance text that proves nothing. */
const UNVERIFIABLE = [
  /^(it )?works?$/i,
  /^looks? (good|right|fine)$/i,
  /^(is )?(done|complete|finished)$/i,
  /^manually (check|verify|test)/i,
  /^(i|you) (can|should) see\b/i,
  /^verify (that )?it/i,
  /^no (obvious )?(bugs|issues|problems)$/i,
];

/** Things nobody should be doing while the user is asleep. */
const DANGEROUS = [
  { pattern: /\bgit\s+push\b/i, why: 'pushes to a remote' },
  { pattern: /\bforce[- ]push\b/i, why: 'force-pushes' },
  { pattern: /\bmerge (?:into|to) (?:main|master)\b/i, why: 'merges into a mainline branch' },
  { pattern: /\bdeploy(?:ing|ment)? to (?:prod|production|staging)\b/i, why: 'deploys' },
  { pattern: /\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, why: 'publishes a package' },
  { pattern: /\bdrop (?:the )?(?:database|table)\b/i, why: 'drops database objects' },
  { pattern: /\bproduction (?:database|migration)\b/i, why: 'touches production data' },
  { pattern: /\brotate (?:the )?(?:keys|secrets|credentials)\b/i, why: 'handles live credentials' },
  { pattern: /\bsend (?:an? )?(?:email|slack|message)\b/i, why: 'sends messages to people' },
  { pattern: /\bopen a (?:pr|pull request)\b/i, why: 'creates a pull request' },
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validatePlan(planMarkdown, { repoRoot = process.cwd(), env = process.env } = {}) {
  const errors = [];
  const warnings = [];

  let plan;
  try {
    plan = parsePlan(planMarkdown);
  } catch (error) {
    if (error instanceof PlanError) {
      return { ok: false, errors: [`Plan could not be parsed — ${error.message}`], warnings: [], plan: null, order: [] };
    }
    throw error;
  }

  for (const warning of plan.warnings) warnings.push(warning);

  let repoConfig = {};
  try {
    repoConfig = readRepoConfig(repoRoot);
  } catch (error) {
    errors.push(error.message);
  }

  const { settings, errors: settingErrors, unknown } = resolveSettings({
    planSettings: plan.settings,
    repoConfig,
    env,
  });
  errors.push(...settingErrors);
  for (const key of unknown) {
    warnings.push(`Settings: "${key}" is not a recognized setting and will be ignored.`);
  }

  if (plan.tasks.length === 0) {
    errors.push('The plan has no tasks. Each task needs a "## Task: <id> — <title>" heading.');
    return { ok: false, errors, warnings, plan, settings, order: [] };
  }

  // --- per-task checks -----------------------------------------------------
  const seen = new Map();
  for (const task of plan.tasks) {
    const where = `Task ${task.id ?? `at line ${task.headingLine}`}`;

    if (!task.id) {
      errors.push(`${where}: missing "id". Add an id to the yaml block so state can be tracked across restarts.`);
    } else if (!ID_PATTERN.test(task.id)) {
      errors.push(`${where}: id "${task.id}" must be letters, digits, dot, dash or underscore.`);
    } else if (seen.has(task.id)) {
      errors.push(`${where}: duplicate id "${task.id}" (also at line ${seen.get(task.id)}).`);
    } else {
      seen.set(task.id, task.headingLine);
    }

    if (!task.title || task.title.length < 3) {
      errors.push(`${where}: missing a title.`);
    }
    if (!task.goal || task.goal.length < 20) {
      errors.push(
        `${where}: the "### Goal" section is missing or too short. A worker starting with no conversation history needs the intent written down.`,
      );
    }

    // Acceptance criteria are the whole point of the format.
    if (task.acceptance.length === 0) {
      errors.push(
        `${where}: no acceptance criteria. Add at least one command that proves the task is done, e.g. "- command: npm test -- src/foo".`,
      );
    }
    let runnable = 0;
    for (const entry of task.acceptance) {
      if (entry.command) {
        runnable++;
        if (UNVERIFIABLE.some((re) => re.test(entry.command.trim()))) {
          errors.push(`${where}: acceptance "${entry.command}" is not a command that can be run. Replace it with something a shell can execute.`);
        }
        if (!['exit_zero', 'exit_nonzero'].includes(entry.expect)) {
          errors.push(`${where}: acceptance "expect" must be exit_zero or exit_nonzero, got "${entry.expect}".`);
        }
      } else if (entry.check) {
        if (UNVERIFIABLE.some((re) => re.test(String(entry.check).trim()))) {
          errors.push(`${where}: the check "${entry.check}" cannot be verified. Say what specifically must be true.`);
        } else {
          warnings.push(`${where}: the check "${entry.check}" will be judged by the reviewer, not run as a command. At least one runnable command is safer.`);
        }
      }
    }
    if (runnable === 0 && task.acceptance.length > 0) {
      errors.push(
        `${where}: every acceptance entry is prose. Without one runnable command, "done" is only the model's opinion.`,
      );
    }

    if (task.scope.length === 0) {
      warnings.push(`${where}: no "scope" listed, so the whole repository is in play. Listing files or directories makes scope violations detectable.`);
    }

    if (typeof task.max_attempts !== 'number' || task.max_attempts < 1 || task.max_attempts > 10) {
      errors.push(`${where}: "max_attempts" must be a number from 1 to 10, got ${JSON.stringify(task.max_attempts)}.`);
    }
    if (typeof task.priority !== 'number') {
      errors.push(`${where}: "priority" must be a number (lower runs first), got ${JSON.stringify(task.priority)}.`);
    }

    // Would this stall waiting for a person?
    const prose = `${task.title}\n${task.goal}\n${task.notes}`;
    for (const pattern of NEEDS_HUMAN) {
      if (pattern.test(prose)) {
        errors.push(
          `${where}: reads as if it needs a person mid-run (matched ${pattern}). Nobody is awake. Decide it now, or tell the worker which assumption to make.`,
        );
        break;
      }
    }

    for (const { pattern, why } of DANGEROUS) {
      if (pattern.test(prose) || task.acceptance.some((a) => a.command && pattern.test(a.command))) {
        errors.push(`${where}: ${why}, which the plugin blocks during an unattended run. Remove it and do that step yourself in the morning.`);
      }
    }

    // Too large for one fresh-context session?
    const sizeSignals = [];
    if (task.scope.length > 12) sizeSignals.push(`${task.scope.length} files in scope`);
    if (task.acceptance.length > 6) sizeSignals.push(`${task.acceptance.length} acceptance criteria`);
    if (task.goal.split(/\s+/).length > 400) sizeSignals.push('a very long goal');
    const conjunctions = (task.title.match(/\b(and|then|also|plus)\b/gi) || []).length;
    if (conjunctions >= 2) sizeSignals.push('a title describing several separate outcomes');
    if (sizeSignals.length >= 2) {
      warnings.push(
        `${where}: looks large for a single session (${sizeSignals.join(', ')}). Splitting it means a failure costs one task instead of the night.`,
      );
    }

    if (task.allow_package_install === true && settings.allow_package_install !== true) {
      warnings.push(`${where}: opts into package installs, which the run-level setting otherwise forbids. Installs will be allowed for this task only.`);
    }
  }

  // --- dependency graph ----------------------------------------------------
  const ids = new Set(plan.tasks.filter((t) => t.id).map((t) => t.id));
  for (const task of plan.tasks) {
    for (const dep of task.depends_on) {
      if (dep === task.id) {
        errors.push(`Task ${task.id}: depends on itself.`);
      } else if (!ids.has(dep)) {
        errors.push(`Task ${task.id}: depends on "${dep}", which is not a task in this plan.`);
      }
    }
  }

  const { order, cycles } = topologicalOrder(plan.tasks);
  for (const cycle of cycles) {
    errors.push(`Circular dependency: ${cycle.join(' → ')} → ${cycle[0]}. Nothing in that group could ever start.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    plan,
    settings,
    order,
  };
}

/**
 * Execution order: dependencies first, then ascending priority, then plan order.
 * Also reports every cycle found, so validate can name them.
 */
export function topologicalOrder(tasks) {
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const indexOf = new Map([...byId.keys()].map((id, index) => [id, index]));
  const state = new Map();
  const order = [];
  const cycles = [];

  const visit = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      const start = stack.indexOf(id);
      cycles.push(stack.slice(start));
      return;
    }
    state.set(id, 'active');
    const task = byId.get(id);
    const deps = (task?.depends_on ?? []).filter((d) => byId.has(d));
    deps.sort((a, b) => rank(byId.get(a), indexOf.get(a)) - rank(byId.get(b), indexOf.get(b)));
    for (const dep of deps) visit(dep, [...stack, id]);
    state.set(id, 'done');
    order.push(id);
  };

  const roots = [...byId.keys()].sort((a, b) => rank(byId.get(a), indexOf.get(a)) - rank(byId.get(b), indexOf.get(b)));
  for (const id of roots) visit(id, []);

  // De-duplicate cycles reported from different entry points.
  const unique = [];
  const signatures = new Set();
  for (const cycle of cycles) {
    const signature = [...cycle].sort().join('|');
    if (!signatures.has(signature)) {
      signatures.add(signature);
      unique.push(cycle);
    }
  }
  return { order, cycles: unique };
}

function rank(task, index) {
  return (task?.priority ?? 100) * 1000 + (index ?? 0);
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { plan: 'OVERNIGHT_PLAN.md', repo: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') args.plan = argv[++i];
    else if (argv[i] === '--repo') args.repo = argv[++i];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const planPath = path.isAbsolute(args.plan) ? args.plan : path.join(args.repo, args.plan);

  if (!fs.existsSync(planPath)) {
    const message = `No plan found at ${planPath}. Run /overnight:plan to write one.`;
    if (args.json) console.log(JSON.stringify({ ok: false, errors: [message], warnings: [] }, null, 2));
    else console.error(message);
    process.exit(2);
  }

  const result = validatePlan(fs.readFileSync(planPath, 'utf8'), { repoRoot: args.repo });

  if (args.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      order: result.order,
      taskCount: result.plan?.tasks.length ?? 0,
      settings: result.settings ?? null,
    }, null, 2));
  } else {
    const taskCount = result.plan?.tasks.length ?? 0;
    console.log(`Plan: ${planPath}`);
    console.log(`Tasks: ${taskCount}`);
    if (result.order?.length) console.log(`Execution order: ${result.order.join(' → ')}`);
    console.log('');
    if (result.errors.length) {
      console.log(`${result.errors.length} problem(s) that must be fixed before starting:`);
      for (const error of result.errors) console.log(`  ✗ ${error}`);
      console.log('');
    }
    if (result.warnings.length) {
      console.log(`${result.warnings.length} thing(s) worth a second look:`);
      for (const warning of result.warnings) console.log(`  ! ${warning}`);
      console.log('');
    }
    console.log(result.ok ? 'Plan is ready to run.' : 'Plan is not ready to run.');
  }
  process.exit(result.ok ? 0 : 1);
}

export default { validatePlan, topologicalOrder };
