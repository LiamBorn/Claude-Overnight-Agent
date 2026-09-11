#!/usr/bin/env node
/**
 * guard.mjs — PreToolUse hook. The second safety layer, for the forms the first cannot see.
 *
 * Permission rules match the command text Claude writes. They are documented as *not* a
 * boundary around a program: `Bash(git push *)` does not match `git -C . push`, nor
 * `sh -c 'git push'`, nor `FOO=1 /usr/bin/git push`. This hook scans the raw command
 * string instead, so those spellings are caught too.
 *
 * It also re-checks, before every single Bash call, that HEAD is still on the overnight
 * branch. If anything has moved the run off that branch, everything stops.
 *
 * IMPORTANT: plugin hooks load in *every* session once the plugin is installed. This hook
 * must therefore do nothing at all unless OVERNIGHT_RUN=1 is set, which only the runner
 * sets. Without that check it would block `git push` during ordinary daytime work.
 *
 * Failure policy: fail closed. If the guard cannot decide, it denies. A night of denied
 * tasks with a clear reason in the report beats one silent push to a shared branch.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// --- the early exit that keeps daytime sessions untouched -------------------
if (process.env.OVERNIGHT_RUN !== '1') process.exit(0);

const REPO_ROOT = process.env.OVERNIGHT_REPO_ROOT || process.cwd();
const BRANCH = process.env.OVERNIGHT_BRANCH || '';
const ALLOW_NETWORK = process.env.OVERNIGHT_ALLOW_NETWORK === '1';
const ALLOW_INSTALL = process.env.OVERNIGHT_ALLOW_INSTALL === '1';

/**
 * Command-shape rules. Each matches anywhere in the raw command string, so wrappers,
 * `-C` flags, absolute paths and `sh -c` quoting do not help anything slip through.
 */
const FORBIDDEN = [
  { re: /\bgit\b[^;&|]*?\bpush\b/i, why: 'pushes to a remote. Overnight work stays local; push it yourself after review.' },
  { re: /\bgit\b[^;&|]*?\bremote\s+(add|set-url|remove|rename)\b/i, why: 'changes git remotes.' },
  { re: /\bgit\b[^;&|]*?\b(merge|rebase|cherry-pick)\b/i, why: 'rewrites or merges history, which is a decision for the morning.' },
  { re: /\bgit\b[^;&|]*?\b(checkout|switch)\b/i, why: 'moves off the overnight branch.' },
  { re: /\bgit\b[^;&|]*?\bbranch\b\s+-[dD]\b/i, why: 'deletes a branch.' },
  { re: /\bgit\b[^;&|]*?\bfilter-branch\b/i, why: 'rewrites history.' },
  { re: /\bgit\b[^;&|]*?\breset\s+--hard\b/i, why: 'discards work. Only the runner may reset the tree.' },
  { re: /\bgit\b[^;&|]*?\bcommit\b/i, why: 'commits. The runner commits, and only after the reviewer passes.' },
  { re: /\bgit\b[^;&|]*?\bconfig\b/i, why: 'changes git configuration.' },

  { re: /(^|[\s;&|(])(gh|glab|hub)(\s|$)/i, why: 'talks to a code-hosting service.' },
  { re: /(^|[\s;&|(])claude(\s|$)/i, why: 'would start another Claude Code session outside the runner\'s supervision.' },
  { re: /(^|[\s;&|(])(nohup|disown|screen|tmux|at|crontab)(\s|$)/i, why: 'would leave a process running past the end of the run.' },
  { re: /(^|[\s;&|(])(sudo|doas|su)(\s|$)/i, why: 'escalates privileges.' },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt|launchctl|systemctl|diskutil|mkfs|dd)(\s|$)/i, why: 'changes the state of the machine.' },
  { re: /(^|[\s;&|(])(killall|pkill)(\s|$)/i, why: 'kills processes it does not own, possibly the runner.' },
  { re: /(^|[\s;&|(])(chmod|chown|chgrp)(\s|$)/i, why: 'changes file ownership or permissions.' },

  { re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b|\bcargo\s+publish\b|\btwine\b|\bgem\s+push\b/i, why: 'publishes a package.' },
  { re: /\bdocker\b[^;&|]*\bpush\b|\bkubectl\b|\bhelm\b|\bterraform\b|\bpulumi\b|\bansible\b/i, why: 'deploys infrastructure.' },
  { re: /(^|[\s;&|(])(vercel|netlify|flyctl|fly|heroku|railway|serverless|sls|eb|pm2)(\s|$)/i, why: 'deploys an application.' },
  { re: /(^|[\s;&|(])(aws|gcloud|az)(\s|$)/i, why: 'talks to a cloud provider.' },

  { re: /\brm\b[^;&|]*\s+(-[a-zA-Z]*\s+)*(\/|~\/?)(\s|$)/, why: 'would delete a root or home path.' },
  { re: /\brm\b[^;&|]*-[a-zA-Z]*r[a-zA-Z]*f|rm\b[^;&|]*-[a-zA-Z]*f[a-zA-Z]*r/i, why: 'is a recursive force delete; check the path is inside the project and delete the files individually.', pathScoped: true },

  { re: /\bprintenv\b|(^|[\s;&|(])env(\s*$|\s*\|)/i, why: 'dumps the environment, which can contain credentials.' },
  { re: /(^|[\s;&|(])security\s+find-|(^|[\s;&|(])keychain(\s|$)/i, why: 'reads the system keychain.' },
  { re: /\.env\b[^;&|]*\|\s*(curl|nc|mail)|\bcat\b[^;&|]*\.env\b/i, why: 'reads an environment file.' },
];

const NETWORK = {
  re: /(^|[\s;&|(])(curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync|ftp)(\s|$)/i,
  why: 'reaches the network, which is off by default for unattended runs. Set allow_network: true in the plan to permit it.',
};

const INSTALL = {
  re: /\b(npm\s+(i|install|ci|add)|yarn\s+add|pnpm\s+(add|install)|pip3?\s+install|poetry\s+add|cargo\s+add|go\s+get|gem\s+install|brew\s+(install|upgrade)|apt(-get)?\s+install)\b/i,
  why: 'installs packages, which is off by default. Set allow_package_install: true in the plan to permit it.',
};

const SECRET_PATH = /(^|\/)(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore)$|(^|\/)(\.ssh|\.aws|\.gnupg|secrets)(\/|$)/i;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by the overnight guard: ${reason}`,
    },
    systemMessage: `overnight guard blocked a tool call: ${reason}`,
  }));
  process.exit(0);
}

function allow() {
  process.exit(0);
}

let branchCache = null;
function branchIsCorrect() {
  if (!BRANCH) return true;
  const now = Date.now();
  if (branchCache && now - branchCache.at < 5000) return branchCache.ok;
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const ok = result.status === 0 && result.stdout.trim() === BRANCH;
  branchCache = { at: now, ok, saw: result.stdout.trim() };
  return ok;
}

function insideRepo(filePath) {
  if (!filePath) return true;
  const resolved = path.resolve(REPO_ROOT, filePath);
  const root = path.resolve(REPO_ROOT);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny('the hook could not read the tool call, so it refused it rather than guess.');
    return;
  }

  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '');

    if (!branchIsCorrect()) {
      deny(
        `HEAD is on "${branchCache?.saw ?? 'unknown'}" but this run owns "${BRANCH}". Nothing may run until the branch is restored.`,
      );
      return;
    }

    for (const rule of FORBIDDEN) {
      if (!rule.re.test(command)) continue;
      if (rule.pathScoped) {
        // A recursive delete is fine inside the project and never fine outside it.
        const targets = command.split(/\s+/).filter((t) => !t.startsWith('-') && t !== 'rm');
        const escapes = targets.filter((t) => !insideRepo(t.replace(/['"]/g, '')));
        if (escapes.length === 0) continue;
        deny(`${rule.why} It targets ${escapes.join(', ')}, which is outside the project.`);
        return;
      }
      deny(`the command ${rule.why}`);
      return;
    }

    if (!ALLOW_NETWORK && NETWORK.re.test(command)) {
      deny(`the command ${NETWORK.why}`);
      return;
    }
    if (!ALLOW_INSTALL && INSTALL.re.test(command)) {
      deny(`the command ${INSTALL.why}`);
      return;
    }

    // Redirections and reads that name a secret file.
    const words = command.split(/[\s'"<>|;&]+/).filter(Boolean);
    for (const word of words) {
      if (SECRET_PATH.test(word)) {
        deny(`the command names ${word}, which looks like a secret or credential file.`);
        return;
      }
    }
    allow();
    return;
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const filePath = input.file_path ?? input.notebook_path ?? '';
    if (!insideRepo(filePath)) {
      deny(`${filePath} is outside the project directory. Overnight runs only modify the project.`);
      return;
    }
    if (SECRET_PATH.test(filePath)) {
      deny(`${filePath} looks like a secret or credential file.`);
      return;
    }
    if (path.resolve(REPO_ROOT, filePath).includes(`${path.sep}.git${path.sep}`)) {
      deny('writing inside .git would corrupt the repository.');
      return;
    }
    allow();
    return;
  }

  if (tool === 'WebFetch' || tool === 'WebSearch') {
    if (!ALLOW_NETWORK) {
      deny('network access is off for this run. Set allow_network: true in the plan to permit it.');
      return;
    }
    allow();
    return;
  }

  allow();
}

main().catch((error) => {
  // Fail closed: an unattended run must not proceed on a guard that is not working.
  deny(`the guard itself failed (${error.message}).`);
});
