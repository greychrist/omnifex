import fs from 'node:fs';
import path from 'node:path';

/** Pre-trusts the scratch dir with `hasTrustDialogAccepted` and `hasCompletedProjectOnboarding` in .claude.json, as accepting the dialog would. */

export interface ScratchCwdDeps {
  userDataDir: string;
}

/** Throws on invalid .claude.json so the failure surfaces instead of launching into the trust dialog. */
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

  // Leave the file untouched when nothing changes: Claude may be writing it concurrently.
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

  // temp + rename, pid-tagged so concurrent OmniFex processes don't collide.
  const tmp = `${claudeJsonPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2));
  fs.renameSync(tmp, claudeJsonPath);

  return scratchDir;
}

function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function readClaudeJson(p: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
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
