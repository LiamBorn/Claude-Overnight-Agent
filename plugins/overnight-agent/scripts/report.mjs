/**
 * report.mjs — the morning report, and the dry-run report.
 *
 * The morning report is assembled mechanically from state.json and git. No model writes
 * any of the facts in it, because a report that can hallucinate is worse than no report:
 * the whole point is that the user can trust it before they have read a line of the diff.
 *
 * One optional narrative paragraph at the very end is model-written, and is labelled as
 * such so nobody confuses it with the record.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as git from './gitops.mjs';
import * as S from './state.mjs';

const STATUS_LABEL = {
  done: 'Done',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
  pending: 'Never started',
  running: 'Interrupted',
};

function duration(fromIso, toIso) {
  if (!fromIso || !toIso) return 'unknown';
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function local(iso) {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString();
}

/**
 * Review order: dependencies before dependents, and within that, riskiest first.
 * Risk is the honest signal set — scope violations, shortcut flags, retries needed.
 */
function reviewOrder(state) {
  const done = Object.values(state.tasks).filter((t) => t.status === 'done');
  const riskOf = (task) =>
    task.scope_violations.length * 3 +
    task.cheat_flags.length * 5 +
    Math.max(0, task.attempts - 1) * 2 +
    task.assumptions.length;

  const ordered = [];
  const placed = new Set();
  const remaining = [...done];
  while (remaining.length) {
    const ready = remaining.filter((task) =>
      task.depends_on.every((dep) => placed.has(dep) || state.tasks[dep]?.status !== 'done'),
    );
    const pool = ready.length ? ready : remaining;
    pool.sort((a, b) => riskOf(b) - riskOf(a) || a.id.localeCompare(b.id));
    const next = pool[0];
    ordered.push({ task: next, risk: riskOf(next) });
    placed.add(next.id);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return ordered;
}

function riskNote(task) {
  const notes = [];
  if (task.cheat_flags.length) notes.push(`${task.cheat_flags.length} shortcut flag(s) the reviewer had to clear`);
  if (task.scope_violations.length) notes.push(`${task.scope_violations.length} file(s) outside declared scope`);
  if (task.attempts > 1) notes.push(`took ${task.attempts} attempts`);
  if (task.assumptions.length) notes.push(`${task.assumptions.length} assumption(s) recorded`);
  return notes.length ? notes.join(', ') : 'clean first pass';
}

export function buildReport({ repoRoot, state, specsById }) {
  const counts = S.countByStatus(state);
  const tasks = Object.values(state.tasks);
  const done = tasks.filter((t) => t.status === 'done');
  const notDone = tasks.filter((t) => ['failed', 'blocked', 'skipped', 'pending', 'running'].includes(t.status));
  const lines = [];

  const push = (...text) => lines.push(...text);

  // --- header --------------------------------------------------------------
  push(`# Overnight report — ${new Date(state.started_at).toLocaleDateString()}`);
  push('');
  push(`**${counts.done} of ${tasks.length} tasks completed and committed.**`);
  const headline = [];
  if (counts.failed) headline.push(`${counts.failed} failed`);
  if (counts.blocked) headline.push(`${counts.blocked} blocked`);
  if (counts.skipped) headline.push(`${counts.skipped} skipped`);
  if (headline.length) push(`${headline.join(', ')}. Details below.`);
  push('');
  push(`- Branch: \`${state.branch}\` (branched from \`${state.base_branch}\` at \`${state.base_commit.slice(0, 8)}\`)`);
  push(`- Ran from ${local(state.started_at)} to ${local(state.finished_at)} (${duration(state.started_at, state.finished_at)})`);
  push(`- Ended because ${state.stop_reason ?? 'the run finished'}`);
  push(`- Nothing was pushed, merged, or deployed. \`${state.base_branch}\` is untouched.`);
  push('');

  if (state.baseline) {
    const already = state.baseline.exit_code !== 0;
    push(
      `> Baseline recorded before the run: \`${state.baseline.command}\` exited ${state.baseline.exit_code}.` +
        (already
          ? ' It was **already failing** before any overnight work, so treat pre-existing failures accordingly.'
          : ' It was passing before the run started.'),
    );
    push('');
  }

  // --- review instructions -------------------------------------------------
  push('## How to review this');
  push('');
  push('```bash');
  push(`git -C ${JSON.stringify(repoRoot)} log --oneline ${state.base_commit}..${state.branch}`);
  push(`git -C ${JSON.stringify(repoRoot)} diff ${state.base_commit}..${state.branch}`);
  push('```');
  push('');

  const order = reviewOrder(state);
  if (order.length) {
    push('Suggested order, dependencies first and riskiest first within that:');
    push('');
    order.forEach(({ task }, index) => {
      push(`${index + 1}. **${task.id}** — ${task.title}  \n   \`git show ${task.commit?.slice(0, 10) ?? 'n/a'}\` — ${riskNote(task)}`);
    });
    push('');
  }

  // --- completed -----------------------------------------------------------
  push('## Completed');
  push('');
  if (!done.length) {
    push('Nothing completed.');
    push('');
  } else {
    push('| Task | Title | Commit | Attempts | Verified by |');
    push('| --- | --- | --- | --- | --- |');
    for (const task of done) {
      const last = task.attempt_log[task.attempt_log.length - 1];
      const verified = (last?.acceptance ?? []).map((a) => `\`${a.command}\``).join(', ') || 'no runnable criteria';
      push(`| ${task.id} | ${task.title} | \`${task.commit?.slice(0, 8) ?? '—'}\` | ${task.attempts} | ${verified} |`);
    }
    push('');

    for (const task of done) {
      const last = task.attempt_log[task.attempt_log.length - 1];
      push(`### ${task.id} — ${task.title}`);
      push('');
      if (last?.summary) push(`${last.summary}`, '');
      const stat = task.commit ? git.diffStat(repoRoot, `${task.commit}^`, task.commit) : '';
      if (stat) {
        push('```');
        push(stat);
        push('```');
        push('');
      }
      if (last?.review?.reasons?.length) {
        push(`Reviewer: ${last.review.reasons.map((r) => r.replace(/\n/g, ' ')).join(' ')}`);
        push('');
      }
      const rejected = task.attempt_log.slice(0, -1);
      if (rejected.length) {
        push(`This took ${task.attempts} attempts. What was caught and corrected first:`);
        for (const attempt of rejected) {
          push(`- Attempt ${attempt.n}: ${attempt.reason ?? attempt.detail ?? 'failed'}`);
          if (attempt.patch) push(`  - That attempt is kept at \`${attempt.patch}\` if you want to see what it did.`);
        }
        push('');
      }
      if (task.cheat_flags.length) {
        push(`The shortcut scan flagged: ${task.cheat_flags.join('; ')}. The reviewer cleared these, but they are worth your eyes.`);
        push('');
      }
      if (task.scope_violations.length) {
        push(`Changed outside the declared scope: ${task.scope_violations.map((f) => `\`${f}\``).join(', ')}.`);
        push('');
      }
    }
  }

  // --- not completed -------------------------------------------------------
  push('## Not completed');
  push('');
  if (!notDone.length) {
    push('Everything in the plan finished.');
    push('');
  } else {
    for (const task of notDone) {
      push(`### ${task.id} — ${task.title} (${STATUS_LABEL[task.status]})`);
      push('');
      push(task.reason ?? 'No reason was recorded.');
      push('');
      if (task.attempt_log.length) {
        push(`Attempts: ${task.attempts}. What happened each time:`);
        for (const attempt of task.attempt_log) {
          const failed = (attempt.acceptance ?? []).filter((a) => !a.passed);
          const detail = attempt.reason
            ?? (failed.length
              ? `acceptance failed: ${failed.map((f) => `\`${f.command}\` exited ${f.exit_code}`).join('; ')}`
              : attempt.detail ?? attempt.outcome);
          push(`- Attempt ${attempt.n}: ${detail}`);
          if (attempt.review_reasons?.length) {
            push(`  - Reviewer: ${attempt.review_reasons.join(' ')}`);
          }
          if (attempt.patch) push(`  - The work was saved to \`${attempt.patch}\`, so nothing is lost. Apply it with \`git apply ${attempt.patch}\`.`);
          if (attempt.transcript) push(`  - Transcript: \`${attempt.transcript}\``);
        }
        push('');
      }
      const spec = specsById?.get(task.id);
      if (spec) {
        const firstSentence = (spec.goal || '').replace(/\s+/g, ' ').match(/^.*?[.!?](?=\s|$)/)?.[0]
          ?? (spec.goal || '').replace(/\s+/g, ' ').slice(0, 160);
        push(`To pick this up yourself: the goal was "${firstSentence}" and it needed ${spec.acceptance.filter((a) => a.command).map((a) => `\`${a.command}\``).join(', ') || 'no runnable criteria'} to pass.`);
        push('');
      }
    }
  }

  // --- questions -----------------------------------------------------------
  const questions = tasks.flatMap((t) => t.questions.map((q) => ({ id: t.id, q })));
  push('## Questions for you');
  push('');
  if (!questions.length) {
    push('None came up.');
  } else {
    push('These could not be answered while you were asleep, so they were left for you:');
    push('');
    for (const { id, q } of questions) push(`- **${id}**: ${q}`);
  }
  push('');

  // --- assumptions ---------------------------------------------------------
  const assumptions = tasks.flatMap((t) => t.assumptions.map((a) => ({ id: t.id, a })));
  push('## Assumptions made');
  push('');
  if (!assumptions.length) {
    push('None were recorded.');
  } else {
    push('Every decision below was made without you. If any is wrong, the commit it belongs to is the place to look.');
    push('');
    for (const { id, a } of assumptions) push(`- **${id}**: ${a}`);
  }
  push('');

  // --- diff summary --------------------------------------------------------
  push('## Everything that changed');
  push('');
  const stat = git.diffStat(repoRoot, state.base_commit, state.branch);
  if (stat) {
    push('```');
    push(stat);
    push('```');
  } else {
    push('No files changed.');
  }
  push('');
  const commits = git.shortLog(repoRoot, state.base_commit, state.branch);
  if (commits.length) {
    push(`${commits.length} commit(s):`);
    push('');
    push('```');
    push(commits.join('\n'));
    push('```');
    push('');
  }

  // --- timeline ------------------------------------------------------------
  push('## Timeline');
  push('');
  const limitWaits = state.events.filter((e) => e.kind === 'usage_limit');
  if (limitWaits.length) {
    const totalMs = limitWaits.reduce((sum, e) => sum + (e.wait_ms ?? 0), 0);
    push(`The run paused ${limitWaits.length} time(s) for usage limits, waiting about ${Math.round(totalMs / 60_000)} minutes in total, then resumed from saved state.`);
    push('');
  }
  push('```');
  push(`${state.started_at}  run started on ${state.branch}`);
  for (const event of state.events) {
    push(`${event.at}  ${event.kind}: ${String(event.detail ?? '').slice(0, 160)}`);
  }
  push(`${state.finished_at ?? ''}  run ended — ${state.stop_reason ?? ''}`);
  push('```');
  push('');

  // --- undo ----------------------------------------------------------------
  push('## If you want none of this');
  push('');
  push('The run only ever touched its own branch, so undoing it is two commands:');
  push('');
  push('```bash');
  push(`git -C ${JSON.stringify(repoRoot)} checkout ${state.base_branch}`);
  push(`git -C ${JSON.stringify(repoRoot)} branch -D ${state.branch}`);
  push('```');
  push('');
  push('To keep some of it, cherry-pick the commits you want onto your own branch instead.');
  push('');

  return lines.join('\n');
}

/** Ask for one short narrative paragraph. Clearly labelled, never a source of facts. */
async function narrative({ repoRoot, state, report, invokeClaude, buildSettingsFile, writeSystemPrompt }) {
  const settingsFile = buildSettingsFile(state);
  const systemPromptFile = path.join(S.paths(repoRoot).dir, 'narrator-system-prompt.md');
  fs.writeFileSync(
    systemPromptFile,
    'You summarize an overnight coding run for the person who wrote the plan and has just woken up.\n' +
      'Write at most 120 words of plain prose. No headings, no lists, no code. Say what got done, what did not,\n' +
      'and the one thing they should look at first. State only what the report contains. Do not invent anything.\n',
  );

  const result = await invokeClaude(state, {
    directive: 'Summarize the overnight report on stdin in at most 120 words of plain prose.',
    context: report,
    systemPromptFile,
    schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    model: state.settings.model,
    settingsFile,
    timeoutMs: 5 * 60_000,
    label: 'morning-narrative',
  });
  return result.structured?.summary ?? null;
}

export async function writeReport({ repoRoot, state, specsById, invokeClaude, buildSettingsFile, writeSystemPrompt }) {
  let text = buildReport({ repoRoot, state, specsById });

  if (state.settings?.narrative_summary && invokeClaude) {
    try {
      const summary = await narrative({ repoRoot, state, report: text, invokeClaude, buildSettingsFile, writeSystemPrompt });
      if (summary) {
        text += `\n## In a sentence\n\n_Written by Claude from the report above, not from the run itself._\n\n${summary.trim()}\n`;
      }
    } catch {
      // A missing narrative is not worth failing the report over.
    }
  }

  const destination = S.paths(repoRoot).report;
  fs.writeFileSync(destination, `${text}\n`);
  S.appendLog(repoRoot, `Morning report written to ${path.relative(repoRoot, destination)}.`);
  return destination;
}

// --- dry run ---------------------------------------------------------------

export function writeDryRunReport({ repoRoot, loaded, branch, stopAtMs }) {
  const { plan, settings, order, warnings } = loaded;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const lines = [];
  const push = (...text) => lines.push(...text);

  push('# Overnight dry run');
  push('');
  push('Nothing below was executed. No files were changed, no branch was created, no commit was made.');
  push('');
  push(`- Plan: \`${path.relative(repoRoot, loaded.planPath)}\` — ${plan.tasks.length} task(s)`);
  push(`- Would create branch: \`${branch}\` from \`${git.isGitRepo(repoRoot) ? git.currentBranch(repoRoot) : 'the current branch'}\``);
  push(`- Would stop by: ${new Date(stopAtMs).toLocaleString()}`);
  push(`- Budget: at most ${settings.max_tasks} tasks, ${settings.task_timeout_minutes} min and ${settings.max_turns} turns per attempt`);
  push(`- Would abandon the run after ${settings.max_consecutive_failures} consecutive failures`);
  push(`- Network ${settings.allow_network ? '**allowed**' : 'blocked'}, package installs ${settings.allow_package_install ? '**allowed**' : 'blocked'}`);
  push(`- Independent review: ${settings.skip_review ? '**OFF** — nothing would verify the worker' : `on, using ${settings.reviewer_model}`}`);
  push(`- On failure: ${settings.on_failure === 'revert' ? 'save a patch, then reset the tree to the task\'s starting commit' : 'leave the working tree as it is'}`);
  push('');

  push('## Execution order');
  push('');
  push(order.map((id, index) => `${index + 1}. ${id} — ${byId.get(id)?.title ?? ''}`).join('\n'));
  push('');

  push('## What each task would do');
  push('');
  for (const id of order) {
    const task = byId.get(id);
    if (!task) continue;
    push(`### ${task.id} — ${task.title}`);
    push('');
    push(`- Priority ${task.priority}, up to ${task.max_attempts} attempt(s)`);
    push(`- Depends on: ${task.depends_on.length ? task.depends_on.join(', ') : 'nothing'}`);
    push(`- Scope: ${task.scope.length ? task.scope.map((s) => `\`${s}\``).join(', ') : '**not declared — the whole repository is in play**'}`);
    push('- Would run a fresh worker session, then run these commands itself:');
    for (const entry of task.acceptance) {
      if (entry.command) {
        push(`  - \`${entry.command}\` expecting ${entry.expect === 'exit_nonzero' ? 'a non-zero exit' : 'exit 0'}`);
      } else {
        push(`  - (prose check, judged by the reviewer) ${entry.check}`);
      }
    }
    if (!settings.skip_review) push(`  - then a separate ${settings.reviewer_model} reviewer session on the diff`);
    push(`  - then commit as \`overnight(${task.id}): ${task.title}\``);
    push('');
  }

  if (warnings.length) {
    push('## Warnings');
    push('');
    for (const warning of warnings) push(`- ${warning}`);
    push('');
  }

  push('## What is blocked for the whole run');
  push('');
  push('- Pushing, merging, rebasing, tagging, or moving off the overnight branch');
  push('- Any commit by a worker; only the supervisor commits, and only after review');
  push('- Publishing, deploying, and every cloud or container CLI');
  push('- Reading or writing `.env` files, keys, and credential stores');
  push('- Writing anywhere outside the project directory');
  push(`- ${settings.allow_network ? 'Network access is ALLOWED for this run' : 'Network access'}`);
  push(`- ${settings.allow_package_install ? 'Package installs are ALLOWED for this run' : 'Package installs'}`);
  push('');

  const destination = S.paths(repoRoot).dryRun;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const text = lines.join('\n');
  fs.writeFileSync(destination, `${text}\n`);
  return { text, path: destination };
}

export default { buildReport, writeReport, writeDryRunReport };
