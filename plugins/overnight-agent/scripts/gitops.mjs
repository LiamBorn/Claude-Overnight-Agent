/**
 * gitops.mjs — every git mutation in the run happens here, in the supervisor.
 *
 * Workers get read-only git. The runner owns branching, committing and cleanup, which
 * means the thing that decides "this task is finished" is not the thing that writes
 * the commit. It also means a compromised or confused worker cannot rewrite history.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(repoRoot, args, { allowFailure = false, input } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr || '').trim()}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

export function isGitRepo(dir) {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === 'true';
}

export function repoRootOf(dir) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function currentBranch(repoRoot) {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

export function headCommit(repoRoot) {
  return git(repoRoot, ['rev-parse', 'HEAD']).stdout;
}

export function isClean(repoRoot) {
  return git(repoRoot, ['status', '--porcelain']).stdout === '';
}

export function dirtyFiles(repoRoot) {
  const out = git(repoRoot, ['status', '--porcelain']).stdout;
  return out === '' ? [] : out.split('\n').map((line) => line.slice(3).trim());
}

/**
 * The plan file is normally written but not committed, and .overnight/ is the run's own
 * scratch space. Neither counts as "the user has uncommitted work in flight".
 */
export function dirtyFilesExcept(repoRoot, ignore = []) {
  const normalized = ignore.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
  return dirtyFiles(repoRoot).filter((file) => {
    const clean = file.replace(/^"|"$/g, '');
    if (clean.startsWith('.overnight/') || clean === '.overnight') return false;
    return !normalized.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
  });
}

/** Stage and commit one specific path. Returns the sha, or null if there was nothing to commit. */
export function commitPath(repoRoot, relativePath, message) {
  git(repoRoot, ['add', '--', relativePath], { allowFailure: true });
  const staged = git(repoRoot, ['diff', '--cached', '--name-only']).stdout;
  if (staged === '') return null;
  git(repoRoot, ['commit', '--no-verify', '--file', '-'], { input: message });
  return headCommit(repoRoot);
}

export function branchExists(repoRoot, branch) {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).ok;
}

export function hasCommits(repoRoot) {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true }).ok;
}

/** `overnight/2026-09-11`, or `-2`, `-3`… if that name is taken. */
export function pickBranchName(repoRoot, prefix, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const base = `${prefix}/${stamp}`;
  if (!branchExists(repoRoot, base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!branchExists(repoRoot, candidate)) return candidate;
  }
  throw new Error(`Every branch name from ${base} to ${base}-99 already exists.`);
}

export function createAndCheckout(repoRoot, branch) {
  git(repoRoot, ['checkout', '-b', branch]);
  return branch;
}

export function checkout(repoRoot, branch) {
  git(repoRoot, ['checkout', branch]);
}

/**
 * Keep .overnight/ out of every commit without touching the user's .gitignore.
 * .git/info/exclude is local to this clone and invisible to their teammates.
 */
export function excludeOvernightDir(repoRoot) {
  const excludeFile = path.join(repoRoot, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === '.overnight/')) return false;
  const addition = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}# added by the overnight plugin\n.overnight/\n`;
  fs.appendFileSync(excludeFile, addition);
  return true;
}

/**
 * Stage everything except .overnight/ and commit. Returns the sha, or null if nothing changed.
 *
 * `.overnight/` is kept out by `.git/info/exclude`, which a bare `git add --all` honours.
 * An explicit `:(exclude)` pathspec looks tidier but makes git refuse the whole command when
 * the directory it names is also ignored, so the unstage below is the belt to that brace:
 * it covers the case where `.overnight/` was already tracked before the plugin ran.
 */
export function commitAll(repoRoot, message) {
  git(repoRoot, ['add', '--all']);
  git(repoRoot, ['reset', '--quiet', '--', '.overnight'], { allowFailure: true });
  const staged = git(repoRoot, ['diff', '--cached', '--name-only']).stdout;
  if (staged === '') return null;
  git(repoRoot, ['commit', '--no-verify', '--file', '-'], { input: message });
  return headCommit(repoRoot);
}

/** Everything that changed since `sinceCommit`, working tree included. */
export function changedFiles(repoRoot, sinceCommit) {
  const tracked = git(repoRoot, ['diff', '--name-only', sinceCommit]).stdout;
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']).stdout;
  const set = new Set(
    [...tracked.split('\n'), ...untracked.split('\n')]
      .map((f) => f.trim())
      .filter((f) => f !== '' && !f.startsWith('.overnight/')),
  );
  return [...set].sort();
}

export function diffText(repoRoot, sinceCommit, { maxBytes = 400_000 } = {}) {
  // Record untracked paths in the index so new files appear in the diff. `--intent-to-add`
  // stores the path only, not the content, so this does not stage anything for commit.
  git(repoRoot, ['add', '--intent-to-add', '--all'], { allowFailure: true });
  git(repoRoot, ['reset', '--quiet', '--', '.overnight'], { allowFailure: true });
  const out = git(repoRoot, ['diff', sinceCommit], { allowFailure: true }).stdout;
  if (out.length <= maxBytes) return { text: out, truncated: false };
  return {
    text: `${out.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes]`,
    truncated: true,
  };
}

export function diffStat(repoRoot, fromCommit, toCommit = 'HEAD') {
  return git(repoRoot, ['diff', '--stat', `${fromCommit}..${toCommit}`], { allowFailure: true }).stdout;
}

/** Save the working tree as a patch so a reverted attempt is never actually lost. */
export function savePatch(repoRoot, sinceCommit, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const { text } = diffText(repoRoot, sinceCommit, { maxBytes: Number.MAX_SAFE_INTEGER });
  if (text.trim() === '') return null;
  fs.writeFileSync(destination, `${text}\n`);
  return destination;
}

/**
 * Throw the working tree away and return to `commit`. `.overnight/` is excluded from
 * the clean so the run's own state and logs survive.
 */
export function resetTo(repoRoot, commit) {
  git(repoRoot, ['reset', '--hard', commit]);
  git(repoRoot, ['clean', '-fd', '-e', '.overnight']);
}

export function shortLog(repoRoot, fromCommit, toCommit = 'HEAD') {
  const out = git(repoRoot, ['log', '--oneline', `${fromCommit}..${toCommit}`], { allowFailure: true }).stdout;
  return out === '' ? [] : out.split('\n');
}

export function remoteNames(repoRoot) {
  const out = git(repoRoot, ['remote'], { allowFailure: true }).stdout;
  return out === '' ? [] : out.split('\n');
}

export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export default {
  git,
  isGitRepo,
  repoRootOf,
  currentBranch,
  headCommit,
  isClean,
  dirtyFiles,
  dirtyFilesExcept,
  commitPath,
  branchExists,
  hasCommits,
  pickBranchName,
  createAndCheckout,
  checkout,
  excludeOvernightDir,
  commitAll,
  changedFiles,
  diffText,
  diffStat,
  savePatch,
  resetTo,
  shortLog,
  remoteNames,
  gitAvailable,
};
