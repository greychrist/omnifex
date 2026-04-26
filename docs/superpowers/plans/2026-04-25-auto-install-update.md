# Auto-Install Update Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "mount DMG and drag" install path with a one-click prompt that validates the new ZIP, waits for in-flight sessions/agent runs, swaps `GreyChrist.app` in place via a helper script, and relaunches the app.

**Architecture:** New `installer.ts` main-process service exposes a four-step pipeline (`stage`, `resolveTargetApp`, `waitForIdle`, `executeInstall`). Pre-quit failures surface to the renderer as recoverable errors; post-quit failures are tolerated (worst case: user re-opens the app manually). The titlebar update badge gains `'waiting'` and `'installing'` states; "Install anyway" force-stops in-flight work.

**Tech Stack:** TypeScript, Electron, Vitest, React 18, Tailwind v4. Uses `child_process.spawn` for the detached helper, `ditto` for `.app` copying, and Node's `fs/promises` + `os.tmpdir()` for staging.

**Reference:** Spec at `docs/superpowers/specs/2026-04-25-auto-install-update-design.md`.

---

## File Structure

| File | Role |
|---|---|
| `electron/services/installer.ts` | NEW — `InstallerService` factory; the four-step pipeline |
| `electron/services/installer/helper-script.ts` | NEW — pure function that builds the post-quit shell script. Split out so it's trivially testable. |
| `electron/__tests__/installer.test.ts` | NEW — covers all four pipeline methods |
| `electron/__tests__/installer-helper-script.test.ts` | NEW — covers helper-script generation |
| `electron/services/updater.ts` | Modify — swap DMG_RE for ZIP_RE; update doc comments |
| `electron/__tests__/updater.test.ts` | Modify — fixture filenames `.dmg` → `.zip` |
| `electron/services/sessions/types.ts` | Modify — add `listActiveTabIds()` to `SessionsService` |
| `electron/services/sessions/lifecycle.ts` | Modify — implement `listActiveTabIds()` |
| `electron/__tests__/sessions.test.ts` | Modify — add test for `listActiveTabIds()` |
| `electron/services/agent-run-registry.ts` | Modify — add `listActiveRunIds()` and `killAll()` |
| `electron/__tests__/agent-run-registry.test.ts` (or wherever it's tested) | Modify — tests for the new methods |
| `electron/main.ts` | Modify — construct `installerService`; wire `updater:install` and `updater:install-cancel` handlers; emit `updater:install-status` |
| `electron/preload.ts` | Modify — allow-list `updater:install`, `updater:install-cancel`, `updater:install-status` event prefix |
| `src/lib/api.ts` | Modify — add `installUpdate`, `cancelInstall`, `onInstallStatus` |
| `src/components/CustomTitlebar.tsx` | Modify — extend `UpdateState` with `'waiting'` and `'installing'`; new UI; replace `openUpdate` on success path |
| `CHANGELOG.md` | Modify on release — entry for the feature |

---

## Task 1: Add `listActiveTabIds()` to `SessionsService`

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Test: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('SessionsService', ...)` block (find a sensible location — likely near other lifecycle tests). If `electron/__tests__/sessions.test.ts` lives in a different layout, follow the file's existing pattern.

```typescript
it('listActiveTabIds returns all currently-registered tab IDs', async () => {
  const { service, fakeQuery } = await makeService();  // existing test helper
  service.start({ tabId: 'tab-a', cwd: '/tmp/a', /* ...other required params with defaults */ } as any);
  service.start({ tabId: 'tab-b', cwd: '/tmp/b', /* ... */ } as any);
  expect(service.listActiveTabIds().sort()).toEqual(['tab-a', 'tab-b']);
  service.stop('tab-a');
  expect(service.listActiveTabIds()).toEqual(['tab-b']);
});
```

**If `makeService` / `fakeQuery` helpers do not exist, find the existing pattern in `sessions.test.ts` for how sessions are spun up in tests and adapt. Do NOT invent new test infrastructure — match the existing file.**

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/sessions.test.ts -t "listActiveTabIds"`
Expected: FAIL with `service.listActiveTabIds is not a function`

- [ ] **Step 3: Add the interface entry**

In `electron/services/sessions/types.ts`, inside `interface SessionsService`, add right after `isActive(tabId: string): boolean;`:

```typescript
  /** Return all tab IDs that currently have a registered session handle.
   *  Used by the installer to gate auto-update on in-flight work. */
  listActiveTabIds(): string[];
```

- [ ] **Step 4: Implement in `lifecycle.ts`**

In `electron/services/sessions/lifecycle.ts`, after the `isActive` function definition (around line 532), add:

```typescript
  function listActiveTabIds(): string[] {
    return Array.from(sessions.keys());
  }
```

Then in the returned object (around line 637 where `stopAll`, `isActive`, etc. are listed), add `listActiveTabIds,` to the returned record.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/sessions.test.ts -t "listActiveTabIds"`
Expected: PASS

- [ ] **Step 6: Run the full sessions test file to confirm no regressions**

Run: `npx vitest run electron/__tests__/sessions.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add electron/services/sessions/types.ts electron/services/sessions/lifecycle.ts electron/__tests__/sessions.test.ts
git commit -m "feat(sessions): add listActiveTabIds()"
```

---

## Task 2: Add `listActiveRunIds()` and `killAll()` to `AgentRunRegistry`

**Files:**
- Modify: `electron/services/agent-run-registry.ts`
- Test: locate existing tests with `Glob` for `agent-run-registry`. If a test file exists, modify it; if not, create `electron/__tests__/agent-run-registry.test.ts`.

- [ ] **Step 1: Find or create the test file**

Run: `find electron/__tests__ -name "*agent-run-registry*"`
If found, modify the existing file. If not, create `electron/__tests__/agent-run-registry.test.ts` with this skeleton:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createAgentRunRegistry, type AgentRunHandle } from '../services/agent-run-registry';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

function fakeHandle(): AgentRunHandle {
  const close = vi.fn();
  return { query: { close } as unknown as Query, status: 'running' };
}

describe('AgentRunRegistry', () => {
});
```

- [ ] **Step 2: Write the failing tests**

Add inside the `describe('AgentRunRegistry', ...)` block:

```typescript
  it('listActiveRunIds returns runs whose status is "running"', () => {
    const reg = createAgentRunRegistry();
    reg.register(1, fakeHandle());
    reg.register(2, fakeHandle());
    reg.register(3, fakeHandle());
    reg.setStatus(2, 'completed');
    expect(reg.listActiveRunIds().sort()).toEqual([1, 3]);
  });

  it('killAll calls kill() on every registered run regardless of status', () => {
    const reg = createAgentRunRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    const c = fakeHandle();
    reg.register(1, a);
    reg.register(2, b);
    reg.register(3, c);
    reg.setStatus(2, 'completed');
    reg.killAll();
    expect(a.query.close).toHaveBeenCalled();
    expect(b.query.close).not.toHaveBeenCalled(); // already non-running
    expect(c.query.close).toHaveBeenCalled();
    expect(a.status).toBe('killed');
    expect(c.status).toBe('killed');
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run electron/__tests__/agent-run-registry.test.ts`
Expected: FAIL with `reg.listActiveRunIds is not a function`

- [ ] **Step 4: Implement the new methods**

In `electron/services/agent-run-registry.ts`, add to the `AgentRunRegistry` interface (around line 22-33):

```typescript
  /** Return runIds whose status is 'running'. Used by the installer to gate
   *  auto-update on in-flight work. */
  listActiveRunIds(): number[];
  /** Kill every still-running entry. Used by the installer's "Install anyway"
   *  override. Non-running entries are left alone. */
  killAll(): void;
```

In the `createAgentRunRegistry()` factory return object (after `cleanup`), add:

```typescript
    listActiveRunIds() {
      const ids: number[] = [];
      for (const [runId, handle] of runs) {
        if (handle.status === 'running') ids.push(runId);
      }
      return ids;
    },
    killAll() {
      for (const runId of Array.from(runs.keys())) {
        const handle = runs.get(runId);
        if (handle?.status === 'running') {
          handle.status = 'killed';
          try {
            handle.query.close();
          } catch {
            // close() may throw if the query already ended; ignore
          }
        }
      }
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agent-run-registry.test.ts`
Expected: PASS for both new tests; existing tests (if any) still pass.

- [ ] **Step 6: Commit**

```bash
git add electron/services/agent-run-registry.ts electron/__tests__/agent-run-registry.test.ts
git commit -m "feat(agent-run-registry): add listActiveRunIds and killAll"
```

---

## Task 3: Switch updater from DMG to ZIP

**Files:**
- Modify: `electron/services/updater.ts:97`
- Modify: `electron/__tests__/updater.test.ts` (all `.dmg` fixture filenames → `.zip`)

- [ ] **Step 1: Update the failing fixture in tests**

Open `electron/__tests__/updater.test.ts`. Find every fixture filename of the form `GreyChrist-X.Y.Z-arm64.dmg` and replace with `GreyChrist-darwin-arm64-X.Y.Z.zip`. Use a single edit pass.

For example, if a test has:
```typescript
readdir: async () => ['GreyChrist-0.4.0-arm64.dmg', 'GreyChrist-0.3.5-arm64.dmg'],
```

it should become:

```typescript
readdir: async () => ['GreyChrist-darwin-arm64-0.4.0.zip', 'GreyChrist-darwin-arm64-0.3.5.zip'],
```

Update any matching `assetName` / `expectedFilename` assertions in the test body too.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/__tests__/updater.test.ts`
Expected: FAIL — the regex still matches `.dmg` only.

- [ ] **Step 3: Update the regex in `updater.ts`**

In `electron/services/updater.ts:97`, replace:

```typescript
const DMG_RE = /^GreyChrist-(\d+\.\d+\.\d+)-arm64\.dmg$/;
```

with:

```typescript
const ZIP_RE = /^GreyChrist-darwin-arm64-(\d+\.\d+\.\d+)\.zip$/;
```

Then in `checkForUpdate()` (around line 154-156), update the regex reference:

```typescript
    for (const name of entries) {
      const m = ZIP_RE.exec(name);
      if (!m) continue;
      candidates.push({ version: m[1], filename: name });
    }
```

Update the doc comment block above the regex (around line 91-95) to refer to ZIP instead of DMG:

```typescript
// ---------------------------------------------------------------------------
// Filename pattern — `GreyChrist-darwin-arm64-<major>.<minor>.<patch>.zip`,
// matching the artifact produced by Electron Forge's zip maker.
// The auto-installer service unpacks this ZIP in place of the manual
// DMG-drag flow that predated v0.4.0.
// ---------------------------------------------------------------------------
```

Also update the file-level comment at the top of the file (lines 1-8) — replace "scans a local folder for newer GreyChrist DMG builds" with "scans a local folder for newer GreyChrist ZIP builds".

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add electron/services/updater.ts electron/__tests__/updater.test.ts
git commit -m "feat(updater): scan for ZIP artifacts instead of DMG"
```

---

## Task 4: Helper script generator (pure function)

**Files:**
- Create: `electron/services/installer/helper-script.ts`
- Test: `electron/__tests__/installer-helper-script.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/installer-helper-script.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildHelperScript } from '../services/installer/helper-script';

describe('buildHelperScript', () => {
  it('substitutes parent PID, target app, and staged app paths', () => {
    const script = buildHelperScript({
      parentPid: 12345,
      targetAppPath: '/Applications/GreyChrist.app',
      stagedAppPath: '/tmp/stage/GreyChrist.app',
    });
    expect(script).toContain('PARENT_PID=12345');
    expect(script).toContain('TARGET_APP="/Applications/GreyChrist.app"');
    expect(script).toContain('STAGED_APP="/tmp/stage/GreyChrist.app"');
    expect(script).toContain('while kill -0 "$PARENT_PID"');
    expect(script).toContain('rm -rf "$TARGET_APP"');
    expect(script).toContain('ditto "$STAGED_APP" "$TARGET_APP"');
    expect(script).toContain('open "$TARGET_APP"');
  });

  it('refuses paths containing double-quotes (defensive)', () => {
    expect(() => buildHelperScript({
      parentPid: 1,
      targetAppPath: '/Applications/Bad"Name.app',
      stagedAppPath: '/tmp/x',
    })).toThrow(/quote/i);
  });

  it('starts with a shebang', () => {
    const script = buildHelperScript({ parentPid: 1, targetAppPath: '/a', stagedAppPath: '/b' });
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/__tests__/installer-helper-script.test.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement the helper-script generator**

Create `electron/services/installer/helper-script.ts`:

```typescript
// Pure function — no FS, no spawn. Builds the POSIX shell script that runs
// after the Electron parent quits, replaces the running .app bundle, and
// relaunches the new copy. Kept separate so the unit tests don't have to
// mock anything to exercise the substitution and quoting rules.

export interface HelperScriptParams {
  parentPid: number;
  /** Absolute path to the running GreyChrist.app bundle. */
  targetAppPath: string;
  /** Absolute path to the extracted (new-version) GreyChrist.app bundle. */
  stagedAppPath: string;
}

export function buildHelperScript(params: HelperScriptParams): string {
  if (params.targetAppPath.includes('"') || params.stagedAppPath.includes('"')) {
    // Reject quote characters defensively. Paths produced by the installer
    // come from process.execPath / os.tmpdir() and won't have them, but a
    // misconfigured local_update_dir shouldn't be able to inject shell.
    throw new Error('helper-script: refusing path containing double-quote character');
  }
  return [
    '#!/bin/sh',
    `PARENT_PID=${params.parentPid}`,
    `TARGET_APP="${params.targetAppPath}"`,
    `STAGED_APP="${params.stagedAppPath}"`,
    'SELF=$0',
    '',
    'while kill -0 "$PARENT_PID" 2>/dev/null; do sleep 0.2; done',
    '',
    'rm -rf "$TARGET_APP" || exit 1',
    'ditto "$STAGED_APP" "$TARGET_APP" || exit 1',
    'open "$TARGET_APP"',
    '',
    'rm -rf "$STAGED_APP"',
    'rm -f "$SELF"',
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/installer-helper-script.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/installer/helper-script.ts electron/__tests__/installer-helper-script.test.ts
git commit -m "feat(installer): pure helper-script generator"
```

---

## Task 5: Installer service — `stage()` method

**Files:**
- Create: `electron/services/installer.ts`
- Test: `electron/__tests__/installer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/installer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createInstallerService, type InstallerDeps } from '../services/installer';

function makeDeps(overrides: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    sessionsService: {
      listActiveTabIds: () => [],
      stopAll: () => {},
    },
    agentRunRegistry: {
      listActiveRunIds: () => [],
      killAll: () => {},
    },
    appQuit: vi.fn(),
    spawn: vi.fn(),
    sendToRenderer: vi.fn(),
    execPath: '/Applications/GreyChrist.app/Contents/MacOS/GreyChrist',
    ...overrides,
  };
}

describe('InstallerService.stage', () => {
  let stageDir: string;

  beforeEach(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
  });

  afterEach(async () => {
    await fs.rm(stageDir, { recursive: true, force: true });
  });

  it('throws UpdateFileNotFound when the ZIP is missing', async () => {
    const installer = createInstallerService(makeDeps());
    await expect(
      installer.stage(path.join(stageDir, 'does-not-exist.zip'), '0.4.0'),
    ).rejects.toThrow(/UpdateFileNotFound/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/installer.test.ts`
Expected: FAIL — `installer.ts` doesn't exist.

- [ ] **Step 3: Create the service skeleton**

Create `electron/services/installer.ts`:

```typescript
// Auto-installer for GreyChrist updates. Validates a ZIP, stages it to
// $TMPDIR, waits for in-flight sessions/agent-runs, then spawns a detached
// helper script that swaps GreyChrist.app and relaunches.
//
// Spec: docs/superpowers/specs/2026-04-25-auto-install-update-design.md

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { buildHelperScript } from './installer/helper-script';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InstallStatus {
  phase: 'waiting' | 'installing';
  activeSessions?: number;
  activeAgentRuns?: number;
}

export interface InstallerService {
  stage(zipPath: string, expectedVersion: string): Promise<{ stagedAppPath: string }>;
  resolveTargetApp(): { targetAppPath: string };
  waitForIdle(opts: { force: boolean }): Promise<void>;
  cancelWait(): void;
  executeInstall(stagedAppPath: string, targetAppPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export interface InstallerDeps {
  sessionsService: {
    listActiveTabIds: () => string[];
    stopAll: () => void;
  };
  agentRunRegistry: {
    listActiveRunIds: () => number[];
    killAll: () => void;
  };
  appQuit: () => void;
  spawn: (
    command: string,
    args: string[],
    options: { detached: boolean; stdio: 'ignore' },
  ) => ChildProcess;
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** process.execPath of the running app. Injectable so tests can simulate
   *  packaged vs dev builds without monkey-patching. */
  execPath: string;
  /** Injectable extractor — defaults to `ditto -xk <zip> <dir>`. */
  extractZip?: (zipPath: string, destDir: string) => Promise<void>;
  /** Injectable Info.plist version reader — defaults to plutil. */
  readBundleVersion?: (appPath: string) => Promise<string | null>;
  /** Injectable writability check — defaults to `fs.access(path, W_OK)`. */
  isWritable?: (p: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UpdateFileNotFound extends Error {
  constructor(p: string) { super(`UpdateFileNotFound: ${p}`); this.name = 'UpdateFileNotFound'; }
}
export class InvalidUpdatePackage extends Error {
  constructor(reason: string) { super(`InvalidUpdatePackage: ${reason}`); this.name = 'InvalidUpdatePackage'; }
}
export class VersionMismatch extends Error {
  constructor(expected: string, actual: string) {
    super(`VersionMismatch: expected ${expected}, got ${actual}`);
    this.name = 'VersionMismatch';
  }
}
export class NotPackaged extends Error {
  constructor() { super('NotPackaged'); this.name = 'NotPackaged'; }
}
export class TargetNotWritable extends Error {
  constructor(p: string) { super(`TargetNotWritable: ${p}`); this.name = 'TargetNotWritable'; }
}
export class WaitCancelled extends Error {
  constructor() { super('WaitCancelled'); this.name = 'WaitCancelled'; }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInstallerService(deps: InstallerDeps): InstallerService {
  let cancelToken: { cancelled: boolean } | null = null;

  const extractZip =
    deps.extractZip ??
    (async (zipPath, destDir) => {
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ditto', ['-xk', zipPath, destDir], { stdio: 'ignore' });
        proc.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ditto exited ${code}`));
        });
        proc.on('error', reject);
      });
    });

  const readBundleVersion =
    deps.readBundleVersion ??
    (async (appPath) => {
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      try {
        const { spawn } = await import('node:child_process');
        return await new Promise<string | null>((resolve) => {
          const out: Buffer[] = [];
          const proc = spawn('/usr/bin/plutil', [
            '-extract', 'CFBundleShortVersionString', 'raw', plistPath,
          ], { stdio: ['ignore', 'pipe', 'ignore'] });
          proc.stdout?.on('data', (b) => out.push(b));
          proc.on('exit', (code) => {
            if (code !== 0) return resolve(null);
            resolve(Buffer.concat(out).toString('utf8').trim());
          });
          proc.on('error', () => resolve(null));
        });
      } catch {
        return null;
      }
    });

  const isWritable =
    deps.isWritable ??
    (async (p) => {
      try {
        await fs.access(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });

  async function stage(
    zipPath: string,
    expectedVersion: string,
  ): Promise<{ stagedAppPath: string }> {
    try {
      await fs.access(zipPath);
    } catch {
      throw new UpdateFileNotFound(zipPath);
    }

    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greychrist-stage-'));
    try {
      await extractZip(zipPath, destDir);
    } catch (err) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw new InvalidUpdatePackage(`extraction failed: ${(err as Error).message}`);
    }

    const stagedAppPath = path.join(destDir, 'GreyChrist.app');
    const execPath = path.join(stagedAppPath, 'Contents', 'MacOS', 'GreyChrist');
    try {
      await fs.access(execPath);
    } catch {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw new InvalidUpdatePackage('GreyChrist.app/Contents/MacOS/GreyChrist not found in archive');
    }

    const actualVersion = await readBundleVersion(stagedAppPath);
    if (actualVersion !== expectedVersion) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw new VersionMismatch(expectedVersion, actualVersion ?? '<unreadable>');
    }

    return { stagedAppPath };
  }

  function resolveTargetApp(): { targetAppPath: string } {
    // Walk up from execPath to find the .app bundle. Path looks like:
    //   /Applications/GreyChrist.app/Contents/MacOS/GreyChrist
    // We want /Applications/GreyChrist.app.
    let cur = deps.execPath;
    while (cur !== '/' && cur !== '') {
      if (cur.endsWith('.app')) {
        return { targetAppPath: cur };
      }
      cur = path.dirname(cur);
    }
    throw new NotPackaged();
  }

  function cancelWait(): void {
    if (cancelToken) cancelToken.cancelled = true;
  }

  async function waitForIdle(opts: { force: boolean }): Promise<void> {
    if (opts.force) {
      deps.sessionsService.stopAll();
      deps.agentRunRegistry.killAll();
    }
    const token = { cancelled: false };
    cancelToken = token;

    while (true) {
      if (token.cancelled) {
        cancelToken = null;
        throw new WaitCancelled();
      }
      const sessions = deps.sessionsService.listActiveTabIds().length;
      const runs = deps.agentRunRegistry.listActiveRunIds().length;
      if (sessions === 0 && runs === 0) {
        deps.sendToRenderer('updater:install-status', { phase: 'installing' });
        cancelToken = null;
        return;
      }
      deps.sendToRenderer('updater:install-status', {
        phase: 'waiting',
        activeSessions: sessions,
        activeAgentRuns: runs,
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function executeInstall(
    stagedAppPath: string,
    targetAppPath: string,
  ): Promise<void> {
    const helperPath = path.join(
      os.tmpdir(),
      `greychrist-installer-${Date.now()}.sh`,
    );
    const script = buildHelperScript({
      parentPid: process.pid,
      targetAppPath,
      stagedAppPath,
    });
    await fs.writeFile(helperPath, script, { mode: 0o755 });
    deps.spawn('/bin/sh', [helperPath], { detached: true, stdio: 'ignore' });
    deps.appQuit();
  }

  // Pre-quit writability check. resolveTargetApp() does the structural check;
  // this one ensures we can actually replace the bundle. Called by the IPC
  // handler before kicking off the install pipeline.
  async function ensureTargetWritable(targetAppPath: string): Promise<void> {
    const parent = path.dirname(targetAppPath);
    if (!(await isWritable(parent))) {
      throw new TargetNotWritable(parent);
    }
  }

  return {
    stage,
    resolveTargetApp,
    waitForIdle,
    cancelWait,
    executeInstall,
    // Exposed via cast for the IPC handler in main.ts; not part of the
    // public InstallerService interface (callers go through resolveTargetApp).
    ensureTargetWritable,
  } as InstallerService & { ensureTargetWritable(p: string): Promise<void> };
}
```

- [ ] **Step 4: Run the existing test to confirm it now passes**

Run: `npx vitest run electron/__tests__/installer.test.ts`
Expected: PASS for the missing-ZIP test.

- [ ] **Step 5: Add tests for the rest of `stage()`**

Append inside the existing `describe('InstallerService.stage', ...)` block:

```typescript
  it('throws InvalidUpdatePackage when the ZIP does not contain GreyChrist.app', async () => {
    const zipPath = path.join(stageDir, 'fake.zip');
    await fs.writeFile(zipPath, 'not a real zip');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        // Simulate extraction producing no .app
        await fs.writeFile(path.join(dest, 'README.txt'), 'oops');
      },
    }));
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(/InvalidUpdatePackage/);
  });

  it('throws VersionMismatch when bundle version disagrees with expected', async () => {
    const zipPath = path.join(stageDir, 'pkg.zip');
    await fs.writeFile(zipPath, 'placeholder');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        const appDir = path.join(dest, 'GreyChrist.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'GreyChrist'), 'binary');
      },
      readBundleVersion: async () => '0.3.99',
    }));
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(/VersionMismatch/);
  });

  it('returns stagedAppPath when ZIP is valid and version matches', async () => {
    const zipPath = path.join(stageDir, 'good.zip');
    await fs.writeFile(zipPath, 'placeholder');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        const appDir = path.join(dest, 'GreyChrist.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'GreyChrist'), 'binary');
      },
      readBundleVersion: async () => '0.4.0',
    }));
    const { stagedAppPath } = await installer.stage(zipPath, '0.4.0');
    expect(stagedAppPath).toMatch(/GreyChrist\.app$/);
    await fs.access(stagedAppPath); // exists
  });
```

- [ ] **Step 6: Run tests to confirm all `stage()` paths pass**

Run: `npx vitest run electron/__tests__/installer.test.ts -t "stage"`
Expected: PASS for all four `stage` tests.

- [ ] **Step 7: Commit**

```bash
git add electron/services/installer.ts electron/__tests__/installer.test.ts
git commit -m "feat(installer): stage(zip) extracts and validates update bundle"
```

---

## Task 6: Installer service — `resolveTargetApp()` and `ensureTargetWritable()`

**Files:**
- Modify: `electron/__tests__/installer.test.ts`

(Implementation is already in place from Task 5; this task tests the existing code.)

- [ ] **Step 1: Write the failing tests**

Append to `electron/__tests__/installer.test.ts`:

```typescript
describe('InstallerService.resolveTargetApp', () => {
  it('returns the .app bundle ancestor of execPath', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/Applications/GreyChrist.app/Contents/MacOS/GreyChrist',
    }));
    expect(installer.resolveTargetApp()).toEqual({
      targetAppPath: '/Applications/GreyChrist.app',
    });
  });

  it('throws NotPackaged when execPath is not under a .app', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/Users/dev/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    }));
    // (Electron.app *is* an .app — this case should resolve, not throw.)
    expect(installer.resolveTargetApp()).toEqual({
      targetAppPath: '/Users/dev/repo/node_modules/electron/dist/Electron.app',
    });
  });

  it('throws NotPackaged for execPath without any .app ancestor', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/usr/local/bin/some-binary',
    }));
    expect(() => installer.resolveTargetApp()).toThrow(/NotPackaged/);
  });
});

describe('InstallerService.ensureTargetWritable', () => {
  it('throws TargetNotWritable when parent dir is read-only', async () => {
    const installer = createInstallerService(makeDeps({
      isWritable: async () => false,
    })) as ReturnType<typeof createInstallerService> & {
      ensureTargetWritable(p: string): Promise<void>;
    };
    await expect(installer.ensureTargetWritable('/Applications/GreyChrist.app'))
      .rejects.toThrow(/TargetNotWritable/);
  });

  it('resolves silently when parent dir is writable', async () => {
    const installer = createInstallerService(makeDeps({
      isWritable: async () => true,
    })) as ReturnType<typeof createInstallerService> & {
      ensureTargetWritable(p: string): Promise<void>;
    };
    await expect(installer.ensureTargetWritable('/Applications/GreyChrist.app')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (implementation is already in place)**

Run: `npx vitest run electron/__tests__/installer.test.ts -t "resolveTargetApp"`
Run: `npx vitest run electron/__tests__/installer.test.ts -t "ensureTargetWritable"`
Expected: PASS for all five tests.

- [ ] **Step 3: Commit**

```bash
git add electron/__tests__/installer.test.ts
git commit -m "test(installer): cover resolveTargetApp and ensureTargetWritable"
```

---

## Task 7: Installer service — `waitForIdle()` tests

**Files:**
- Modify: `electron/__tests__/installer.test.ts`

(Implementation already in place; this task adds tests.)

- [ ] **Step 1: Add the tests**

Append to `electron/__tests__/installer.test.ts`:

```typescript
describe('InstallerService.waitForIdle', () => {
  it('emits installing immediately when nothing is in flight', async () => {
    const sendToRenderer = vi.fn();
    const installer = createInstallerService(makeDeps({ sendToRenderer }));
    await installer.waitForIdle({ force: false });
    expect(sendToRenderer).toHaveBeenCalledWith('updater:install-status', { phase: 'installing' });
  });

  it('emits waiting until counts reach zero, then installing', async () => {
    let activeSessions = 2;
    const sendToRenderer = vi.fn();
    const installer = createInstallerService(makeDeps({
      sendToRenderer,
      sessionsService: {
        listActiveTabIds: () => activeSessions > 0 ? new Array(activeSessions).fill('t').map((_, i) => `t-${i}`) : [],
        stopAll: () => {},
      },
    }));
    // Start the wait, then drain sessions over time
    const p = installer.waitForIdle({ force: false });
    setTimeout(() => { activeSessions = 1; }, 1100);
    setTimeout(() => { activeSessions = 0; }, 2100);
    await p;
    const phases = sendToRenderer.mock.calls.map((c) => c[1].phase);
    expect(phases).toContain('waiting');
    expect(phases[phases.length - 1]).toBe('installing');
  });

  it('with force=true calls stopAll and killAll once, then resolves', async () => {
    const stopAll = vi.fn();
    const killAll = vi.fn();
    let activeSessions = 1;
    const installer = createInstallerService(makeDeps({
      sessionsService: {
        listActiveTabIds: () => activeSessions > 0 ? ['t'] : [],
        stopAll: () => { stopAll(); activeSessions = 0; },
      },
      agentRunRegistry: {
        listActiveRunIds: () => [],
        killAll: () => { killAll(); },
      },
    }));
    await installer.waitForIdle({ force: true });
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledTimes(1);
  });

  it('cancelWait rejects the in-flight wait with WaitCancelled', async () => {
    const installer = createInstallerService(makeDeps({
      sessionsService: {
        listActiveTabIds: () => ['t'],
        stopAll: () => {},
      },
    }));
    const p = installer.waitForIdle({ force: false });
    setTimeout(() => installer.cancelWait(), 100);
    await expect(p).rejects.toThrow(/WaitCancelled/);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/installer.test.ts -t "waitForIdle"`
Expected: PASS for all four tests. (The two timing-based tests are slightly slow — ~2s — that's fine.)

- [ ] **Step 3: Commit**

```bash
git add electron/__tests__/installer.test.ts
git commit -m "test(installer): cover waitForIdle gate"
```

---

## Task 8: Installer service — `executeInstall()` tests

**Files:**
- Modify: `electron/__tests__/installer.test.ts`

- [ ] **Step 1: Add the tests**

Append to `electron/__tests__/installer.test.ts`:

```typescript
describe('InstallerService.executeInstall', () => {
  let stageDir: string;
  beforeEach(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-exec-test-'));
  });
  afterEach(async () => {
    await fs.rm(stageDir, { recursive: true, force: true });
  });

  it('writes a helper script, spawns it detached, and calls appQuit', async () => {
    const spawn = vi.fn().mockReturnValue({ unref: () => {} });
    const appQuit = vi.fn();
    const installer = createInstallerService(makeDeps({ spawn, appQuit }));
    await installer.executeInstall('/tmp/stage/GreyChrist.app', '/Applications/GreyChrist.app');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('/bin/sh');
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/greychrist-installer-\d+\.sh$/);
    expect(opts).toEqual({ detached: true, stdio: 'ignore' });

    // The helper script should exist on disk and be executable
    const stat = await fs.stat(args[0]);
    expect(stat.mode & 0o100).toBeTruthy(); // owner executable bit

    const contents = await fs.readFile(args[0], 'utf8');
    expect(contents).toContain('TARGET_APP="/Applications/GreyChrist.app"');
    expect(contents).toContain('STAGED_APP="/tmp/stage/GreyChrist.app"');

    expect(appQuit).toHaveBeenCalledTimes(1);

    // Cleanup the script file we just created
    await fs.unlink(args[0]).catch(() => {});
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run electron/__tests__/installer.test.ts -t "executeInstall"`
Expected: PASS

- [ ] **Step 3: Run the full installer test file to confirm everything passes**

Run: `npx vitest run electron/__tests__/installer.test.ts`
Expected: PASS for all stage / resolveTargetApp / ensureTargetWritable / waitForIdle / executeInstall tests.

- [ ] **Step 4: Commit**

```bash
git add electron/__tests__/installer.test.ts
git commit -m "test(installer): cover executeInstall helper-script + spawn"
```

---

## Task 9: Wire IPC handlers in main process

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`

- [ ] **Step 1: Add channel allow-list entries**

In `electron/preload.ts`, find the `// Updater` section (around line 156-160) and update it to:

```typescript
  // Updater
  'updater:check',
  'updater:download',
  'updater:open',
  'updater:install',
  'updater:install-cancel',
```

Then find where event-channel prefixes are listed (search for `'updater:'` or similar prefix-allow-list entries in preload.ts). Add `'updater:install-status'` to the event-channel allow-list. **If the file uses an exact-match list for events, add it there; if it uses prefix matching, ensure `updater:` is included.** Read the file to see the existing pattern before editing.

- [ ] **Step 2: Add IPC handlers in `electron/main.ts`**

Find the `updater:open` handler (around line 676-681). Right after it, add:

```typescript
  ipcMain.handle('updater:install', async (event, data: any) => {
    const zipPath: string = data?.zipPath ?? data?.zip_path ?? data?.url ?? data;
    const expectedVersion: string = data?.version ?? data?.expectedVersion ?? data?.expected_version;
    const force: boolean = data?.force === true;

    try {
      const { stagedAppPath } = await installerService.stage(zipPath, expectedVersion);
      const { targetAppPath } = installerService.resolveTargetApp();
      // Cast to access ensureTargetWritable (not on public interface).
      await (installerService as any).ensureTargetWritable(targetAppPath);
      await installerService.waitForIdle({ force });
      await installerService.executeInstall(stagedAppPath, targetAppPath);
      // executeInstall calls app.quit() — we never reach this line in practice.
      return { success: true };
    } catch (err: any) {
      // Surface the error name + message so the renderer can show a specific
      // message ("Cannot write to /Applications", etc.).
      throw new Error(`${err.name ?? 'InstallError'}: ${err.message ?? String(err)}`);
    }
  });

  ipcMain.handle('updater:install-cancel', async () => {
    installerService.cancelWait();
    return { success: true };
  });
```

- [ ] **Step 3: Construct the installer service and pass dependencies**

Earlier in `electron/main.ts`, find where `updaterService` is constructed. After it (and after sessionsService and agentRunRegistry are available), add:

```typescript
  const installerService = createInstallerService({
    sessionsService: {
      listActiveTabIds: () => sessionsService.listActiveTabIds(),
      stopAll: () => sessionsService.stopAll(),
    },
    agentRunRegistry: {
      listActiveRunIds: () => agentRunRegistry.listActiveRunIds(),
      killAll: () => agentRunRegistry.killAll(),
    },
    appQuit: () => app.quit(),
    spawn: (cmd, args, opts) => spawn(cmd, args, opts),
    sendToRenderer: (channel, payload) => {
      // Send to all renderers — the install flow is global.
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload));
    },
    execPath: process.execPath,
  });
```

Add the import at the top of `main.ts`:

```typescript
import { createInstallerService } from './services/installer';
import { spawn } from 'node:child_process';
```

(Verify `spawn` and `BrowserWindow` aren't already imported — `BrowserWindow` almost certainly is. If `spawn` is already imported elsewhere, don't duplicate.)

- [ ] **Step 4: Verify type-check passes**

Run: `npm run check`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts
git commit -m "feat(installer): wire IPC handlers and main-process dependency injection"
```

---

## Task 10: Renderer API surface

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Find the existing updater methods**

Run: `Grep` for `checkForUpdate` in `src/lib/api.ts` to locate the section. The new methods belong next to them.

- [ ] **Step 2: Add the new methods**

In `src/lib/api.ts`, after `openUpdate` (around line 2145-2147), add:

```typescript
  async installUpdate(zipPath: string, version: string, opts?: { force?: boolean }): Promise<void> {
    return apiCall("updater:install", {
      zipPath,
      version,
      ...(opts?.force ? { force: true } : {}),
    });
  },

  async cancelInstall(): Promise<void> {
    return apiCall("updater:install-cancel", {});
  },

  onInstallStatus(
    cb: (data: { phase: 'waiting' | 'installing'; activeSessions?: number; activeAgentRuns?: number }) => void,
  ): () => void {
    const handler = (_event: unknown, payload: any) => cb(payload);
    window.electronAPI.on('updater:install-status', handler);
    return () => window.electronAPI.off('updater:install-status', handler);
  },
```

(Verify the event-listener pattern matches what `onUpdateProgress` does — it's just above; copy its shape exactly to be consistent.)

- [ ] **Step 3: Verify type-check passes**

Run: `npm run check`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add installUpdate, cancelInstall, onInstallStatus"
```

---

## Task 11: Renderer state machine — wait + install UI

**Files:**
- Modify: `src/components/CustomTitlebar.tsx`

- [ ] **Step 1: Extend `UpdateState`**

In `src/components/CustomTitlebar.tsx`, replace the `UpdateState` type (lines 38-45):

```typescript
  type UpdateState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'up-to-date' }
    | { status: 'available'; version: string; downloadUrl: string; assetName: string; releaseUrl: string }
    | { status: 'downloading'; percent: number }
    | { status: 'ready'; filePath: string; version: string }
    | { status: 'waiting'; version: string; filePath: string; activeSessions: number; activeAgentRuns: number }
    | { status: 'installing'; version: string }
    | { status: 'error'; downloadUrl: string; assetName: string; releaseUrl: string };
```

- [ ] **Step 2: Subscribe to install-status events**

In the `useEffect` that wires up `onUpdateProgress` (around lines 117-122), add a sibling subscription:

```typescript
    const cleanupInstallStatus = api.onInstallStatus((data) => {
      setUpdateState((prev) => {
        if (prev.status === 'waiting' || prev.status === 'installing' || prev.status === 'ready') {
          if (data.phase === 'waiting') {
            return prev.status === 'waiting'
              ? { ...prev, activeSessions: data.activeSessions ?? 0, activeAgentRuns: data.activeAgentRuns ?? 0 }
              : prev.status === 'installing'
                ? prev // already past the wait — ignore late waiting events
                : { // 'ready' transitioning into 'waiting'
                  status: 'waiting',
                  version: prev.version,
                  filePath: prev.filePath,
                  activeSessions: data.activeSessions ?? 0,
                  activeAgentRuns: data.activeAgentRuns ?? 0,
                };
          }
          if (data.phase === 'installing') {
            const version = prev.status === 'waiting' || prev.status === 'installing'
              ? prev.version
              : prev.version;
            return { status: 'installing', version };
          }
        }
        return prev;
      });
    });
```

And include `cleanupInstallStatus()` in the cleanup return:

```typescript
    return () => {
      clearInterval(sdkTimer);
      cleanupProgress();
      cleanupInstallStatus();
    };
```

- [ ] **Step 3: Replace the "ready → openUpdate" branch with the install pipeline**

Replace the `handleUpdateClick` function (lines 129-151) with:

```typescript
  const handleUpdateClick = async () => {
    if (updateState.status === 'available') {
      const { downloadUrl, assetName, releaseUrl, version } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      try {
        const filePath = await api.downloadUpdate(downloadUrl, assetName);
        setUpdateState({ status: 'ready', filePath, version });
      } catch {
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl });
      }
    } else if (updateState.status === 'ready') {
      // Kick off install. Renderer transitions to 'waiting' or 'installing'
      // based on the install-status events the main process emits.
      const { filePath, version } = updateState;
      try {
        await api.installUpdate(filePath, version);
        // If we get here, the install pipeline returned without quitting —
        // shouldn't happen in practice; treat as error.
        setUpdateState({ status: 'idle' });
      } catch (err: any) {
        // Pre-quit failure (extraction, version mismatch, target not writable, etc.).
        // Drop into 'error' so the user can retry or open in Finder.
        setUpdateState({
          status: 'error',
          downloadUrl: filePath,
          assetName: '',
          releaseUrl: '',
        });
      }
    } else if (updateState.status === 'error') {
      const { downloadUrl, assetName, releaseUrl } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      try {
        const filePath = await api.downloadUpdate(downloadUrl, assetName);
        setUpdateState({ status: 'ready', filePath, version: '' });
      } catch {
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl });
      }
    }
  };

  const handleInstallAnyway = async () => {
    if (updateState.status !== 'waiting') return;
    const { filePath, version } = updateState;
    try {
      await api.installUpdate(filePath, version, { force: true });
    } catch {
      setUpdateState({
        status: 'error',
        downloadUrl: filePath,
        assetName: '',
        releaseUrl: '',
      });
    }
  };

  const handleCancelInstall = async () => {
    if (updateState.status !== 'waiting') return;
    await api.cancelInstall().catch(() => {});
    // Drop back to 'ready' so the user can retry.
    const { filePath, version } = updateState;
    setUpdateState({ status: 'ready', filePath, version });
  };
```

- [ ] **Step 4: Render the new states**

Replace the `AnimatePresence` block at `CustomTitlebar.tsx:211-262` with a version that handles `'waiting'` and `'installing'`. Concrete code:

```tsx
          <AnimatePresence>
          {updateState.status !== 'idle' && (
            <TooltipSimple
              content={
                updateState.status === 'checking' ? 'Checking for updates...' :
                updateState.status === 'up-to-date' ? 'You\'re up to date' :
                updateState.status === 'available' ? `v${updateState.version} available` :
                updateState.status === 'downloading' ? 'Downloading...' :
                updateState.status === 'ready' ? `Install v${updateState.version}` :
                updateState.status === 'waiting' ? `Waiting for ${updateState.activeSessions + updateState.activeAgentRuns} active session(s)` :
                updateState.status === 'installing' ? `Installing v${updateState.version}…` :
                'Retry download'
              }
              side="bottom"
            >
              {updateState.status === 'waiting' ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600/20 text-amber-500 tauri-no-drag"
                >
                  <Loader2 size={13} className="animate-spin" />
                  <span>
                    Waiting for sessions… ({updateState.activeSessions + updateState.activeAgentRuns} active)
                  </span>
                  <button
                    type="button"
                    onClick={handleInstallAnyway}
                    className="ml-1 px-1.5 py-0.5 rounded bg-destructive/80 text-destructive-foreground hover:bg-destructive text-[10px]"
                  >
                    Install anyway
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelInstall}
                    className="px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 text-[10px]"
                  >
                    Cancel
                  </button>
                </motion.div>
              ) : (
                <motion.button
                  onClick={handleUpdateClick}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  whileTap={
                    updateState.status !== 'checking' &&
                    updateState.status !== 'up-to-date' &&
                    updateState.status !== 'installing'
                      ? { scale: 0.97 }
                      : undefined
                  }
                  transition={{ duration: 0.2 }}
                  disabled={updateState.status === 'installing'}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors tauri-no-drag ${
                    updateState.status === 'checking'
                      ? 'bg-muted text-muted-foreground cursor-wait'
                      : updateState.status === 'up-to-date'
                      ? 'bg-green-600/20 text-green-500 cursor-default'
                      : updateState.status === 'available'
                      ? 'bg-primary text-primary-foreground animate-pulse hover:bg-primary/90'
                      : updateState.status === 'downloading'
                      ? 'bg-primary/80 text-primary-foreground cursor-wait'
                      : updateState.status === 'ready'
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : updateState.status === 'installing'
                      ? 'bg-green-600/80 text-white cursor-wait'
                      : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  }`}
                >
                  {updateState.status === 'checking' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'up-to-date' && <CheckCircle size={13} />}
                  {updateState.status === 'available' && <Download size={13} />}
                  {updateState.status === 'downloading' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'ready' && <CheckCircle size={13} />}
                  {updateState.status === 'installing' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'error' && <AlertCircle size={13} />}
                  <span>
                    {updateState.status === 'checking' && 'Checking...'}
                    {updateState.status === 'up-to-date' && 'Up to Date'}
                    {updateState.status === 'available' && 'Update Available!'}
                    {updateState.status === 'downloading' && `${Math.round(updateState.percent)}%`}
                    {updateState.status === 'ready' && 'Install Update'}
                    {updateState.status === 'installing' && 'Installing…'}
                    {updateState.status === 'error' && 'Retry'}
                  </span>
                </motion.button>
              )}
            </TooltipSimple>
          )}
          </AnimatePresence>
```

- [ ] **Step 5: Verify type-check + build**

Run: `npm run check && npm run build`
Expected: No errors, build succeeds.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/CustomTitlebar.tsx
git commit -m "feat(titlebar): waiting + installing states for auto-update"
```

---

## Task 12: Manual verification

This task is not unit-testable — it requires a real packaged build.

- [ ] **Step 1: Rebuild Electron ABI**

Run: `npm run rebuild:electron`
Expected: "verified: native modules at NMV 145 (Electron ABI)"

- [ ] **Step 2: Build a test installer**

Bump `package.json` version to `0.99.0` (a synthetic version higher than current that will be detected as an update). Run: `npm run make`. Expect a new ZIP at `out/make/zip/darwin/arm64/GreyChrist-darwin-arm64-0.99.0.zip`.

Then revert `package.json` back to the actual current version. **Do not commit either change** — these are local-only for testing.

Drop the ZIP into the configured `local_update_dir` (check Settings → General).

- [ ] **Step 3: Launch the app from `/Applications`**

Quit any dev instance. Open `/Applications/GreyChrist.app` (the production-installed version). The titlebar should detect v0.99.0 and offer to install.

- [ ] **Step 4: Walk through the flow**

Click the update badge: should download (instant; file is local), then show "Install vX". Click Install — if no sessions are open, should jump straight to "Installing…" then quit and relaunch as v0.99.0.

If a session IS open: should show "Waiting for sessions…". Stop the session manually → wait disappears, install proceeds. Or click "Install anyway" → session is killed and install proceeds.

- [ ] **Step 5: Verify error paths**

Drop a malformed ZIP into `local_update_dir` (e.g., a renamed text file). After download, click Install → should surface an "InvalidUpdatePackage" error in the badge with an "Open in Finder" fallback.

- [ ] **Step 6: Restore real version**

Drop the synthetic v0.99.0 build out of `local_update_dir`. Move `/Applications/GreyChrist.app` back to the real release if it's been replaced (re-run a real `greychrist-release` flow if needed).

---

## Task 13: Update CHANGELOG (deferred to release)

Defer this until the auto-update feature ships in a real release. At that point, add a CHANGELOG entry under the new version:

```markdown
### Added

- **Auto-install update flow** (`<commit>`). The titlebar update badge now installs new versions in place — click "Install vX", confirm, and the app waits for in-flight sessions to finish (or "Install anyway" stops them), swaps `GreyChrist.app`, and relaunches. Replaces the previous "mount DMG and drag" flow. Installers remain **unsigned**.

### Changed

- **Update artifact** is now the ZIP (`GreyChrist-darwin-arm64-X.Y.Z.zip`) instead of the DMG. The DMG is still produced for users who want the manual install path. The local-update-folder updater scans for ZIPs.
```

This is a release-time task — not part of feature development.
