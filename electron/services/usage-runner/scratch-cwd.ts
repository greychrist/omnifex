import fs from 'node:fs';
import path from 'node:path';

/**
 * The /usage runner spawns Claude Code in a pty and types `/usage`. As of
 * May 2026 Claude Code shows a "Quick safety check: Is this a project you
 * created or one you trust?" dialog the first time it sees a given cwd
 * under a given CLAUDE_CONFIG_DIR — and the dialog text changed in a way
 * the runner's prior heuristic (matching `'trust this folder'`) can't see,
 * so the pty timed out before the welcome screen.
 *
 * Rather than chase Claude's dialog wording, we sidestep it: each account
 * gets its own empty scratch directory under <userData>/usage-cwd/<key>/
 * that we mark "trusted" in <configDir>/.claude.json before launching.
 * Claude reads `projects[<absPath>].hasTrustDialogAccepted` at startup; if
 * it's already true, no dialog is shown and the welcome screen renders
 * directly. This is exactly what the user clicking "Yes, trust this
 * folder" would have written.
 *
 * The schema isn't formally documented (the official settings reference
 * mentions `~/.claude.json` stores "trust settings" without specifying
 * the keys), but is empirically stable: every accepted project entry in
 * a real .claude.json has `hasTrustDialogAccepted: true` and
 * `hasCompletedProjectOnboarding: true`, and we set both.
 */

export interface ScratchCwdDeps {
  /** Result of `app.getPath('userData')` in production. */
  userDataDir: string;
}

/**
 * Ensures a per-account empty directory exists under
 * `<userData>/usage-cwd/<sanitized-accountKey>/` and that the account's
 * `<configDir>/.claude.json` marks that directory as trusted. Idempotent —
 * safe to call on every /usage run; the file is only rewritten when the
 * trust state actually needs to change.
 *
 * Throws if `.claude.json` exists but isn't valid JSON. The runner surfaces
 * that as a normal `UsageRunResult` error so the failure is visible in the
 * UI rather than silently launching into the trust dialog.
 */
export function ensureTrustedScratchCwd(
  accountKey: string,
  configDir: string,
  deps: ScratchCwdDeps,
): string {
  const safeKey = sanitize(accountKey);
  const scratchDir = path.join(deps.userDataDir, 'usage-cwd', safeKey);
  fs.mkdirSync(scratchDir, { recursive: true });

  const claudeJsonPath = path.join(configDir, '.claude.json');
  const root = readClaudeJson(claudeJsonPath);

  const projects = (root.projects && typeof root.projects === 'object')
    ? root.projects as Record<string, Record<string, unknown>>
    : {};
  const existing = (projects[scratchDir] && typeof projects[scratchDir] === 'object')
    ? projects[scratchDir]
    : {};

  // Idempotent fast path — both flags already true → nothing to do, leave
  // the file untouched (preserves mtime for tooling, avoids racing Claude's
  // own writes when it happens to be running with this configDir).
  if (
    existing.hasTrustDialogAccepted === true &&
    existing.hasCompletedProjectOnboarding === true
  ) {
    return scratchDir;
  }

  projects[scratchDir] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  root.projects = projects;

  // Atomic write: temp + rename (rename within the same volume is atomic
  // on POSIX). Tags the temp file with our pid so concurrent OmniFex
  // processes don't trample each other.
  const tmp = `${claudeJsonPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2));
  fs.renameSync(tmp, claudeJsonPath);

  return scratchDir;
}

function sanitize(key: string): string {
  // Filesystem-safe: keep only word chars and dashes. Spaces, slashes,
  // dots, etc. all become underscores.
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function readClaudeJson(p: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Fresh configDir — Claude will fill in the rest of the schema on
      // its next launch; for now we just need a place to hang `projects`.
      return {};
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error('not an object');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `usage-runner: refusing to overwrite malformed ${p} (${reason}). ` +
      `Fix or remove the file and retry.`,
    );
  }
}
