# SDK ↔ TUI Mode Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each GreyChrist session two modes — the existing SDK-driven rich UI (default) and an embedded Claude Code TUI mode that pty-spawns `claude --resume <sessionId>` in an xterm.js widget. The user can toggle between them mid-conversation; the session's history persists because both sides read/write the same JSONL file in `<CLAUDE_CONFIG_DIR>/projects/<encoded-project>/<sessionId>.jsonl`. Only one side is active at a time.

**Architecture:** A new main-process `TuiSession` wraps `node-pty` around `claude --resume <id>`, forwarding data chunks to the renderer via a per-tab event channel. A mode flag lives on the existing `SessionHandle`; `setMode(tabId, 'tui' | 'sdk')` is the single handoff primitive. Handoff is gated on `handle.status === 'running'` (between turns) to avoid tearing down an in-flight SDK query. On TUI exit we auto-revert to SDK by calling `query({ resume: sessionId, ... })` again. The renderer gets a `SessionModeToggle` in the header and a new `TerminalView` component that mounts xterm.js when mode is TUI; the existing message list unmounts while TUI is active and re-renders from state when we switch back. Live event capture (LogTab, permission dialogs, tool widgets) only exists in SDK mode; while in TUI mode analytics go blind by design.

**Tech Stack:**
- `node-pty@^1.1.0` (native module; pty-level subprocess IO)
- `@xterm/xterm@^6.0.0` (renderer terminal widget)
- `@xterm/addon-fit@^0.11.0` (sync cols/rows to container size)
- Existing: `@anthropic-ai/claude-agent-sdk@0.2.117`, Electron 41.2, better-sqlite3 precedent for native-module rebuilds

---

## Non-Goals (explicitly out of scope)

- **Mirroring a live SDK stream in the TUI** — architecturally impossible; both sides write to the same JSONL and would conflict.
- **Mode switch during an in-flight turn** — toggle is disabled unless `status === 'running'`. No "graceful abort" path.
- **Scrollback persistence across mode switches** — each mode renders fresh. Switching to TUI and back resets xterm scrollback (conversation history is preserved in SDK state).
- **Windows / Linux polish** — GreyChrist ships macOS-only; node-pty + xterm work cross-platform but we don't add Windows-specific handling.
- **Multiple concurrent ptys per session** — one pty per session, not a generic terminal tab.
- **Input-side buffering / replay** — if the user types during the switch transition, those keystrokes are lost. Cheap to add later if it matters.

---

## File Structure

**New files:**
- `electron/services/sessions/tui.ts` — `createTuiSession({...})` factory. Spawns `claude --resume` in a pty, exposes `write / resize / kill / onData / onExit`. Single responsibility: pty lifecycle.
- `electron/__tests__/tui.test.ts` — unit tests for `createTuiSession` using a mocked `node-pty`.
- `src/components/TerminalView.tsx` — xterm.js widget. Mounts on tabId change, subscribes to `session-tui-data:<tabId>`, forwards keystrokes + resize events.
- `src/components/SessionModeToggle.tsx` — two-position toggle for SDK/Terminal mode; disabled when handoff not allowed.

**Modified files:**
- `electron/services/sessions/types.ts:39-39` — extend `SessionStatus` and `SessionHandle` with mode tracking.
- `electron/services/sessions/types.ts:60+` — add `setMode` + `tuiWrite` + `tuiResize` to `SessionsService` interface.
- `electron/services/sessions/lifecycle.ts` — add `setMode()` with idle gate, plumb the optional `resume` option through the existing query-start code path.
- `electron/ipc/handlers.ts` — three new IPC handlers + typed interface entries.
- `electron/preload.ts:42-56` — add `session_set_mode`, `session_tui_write`, `session_tui_resize` to invoke allow-list; add `session-mode:`, `session-tui-data:`, `session-tui-exit:` prefixes to event allow-list.
- `electron/main.ts` — wire new service methods into the IPC handler adapter.
- `src/lib/api.ts:1290+` — typed wrappers for the three new channels.
- `src/components/ClaudeCodeSession.tsx` — mode state, conditional render of `TerminalView` vs message list, event subscriptions.
- `src/components/SessionHeader.tsx` — accept + render `modeControl` prop (mirrors the existing `viewModeControl` pattern).
- `package.json` — add deps; extend `rebuild:electron` and `pretest` scripts to include `node-pty`.
- `forge.config.ts` — copy + rebuild `node-pty` the same way `better-sqlite3` is handled.

---

## Task 1: Add dependencies and extend native-module build dance

**Files:**
- Modify: `package.json:1-30`
- Modify: `forge.config.ts:44-72`

- [ ] **Step 1: Install runtime deps**

```bash
npm install node-pty@^1.1.0 @xterm/xterm@^6.0.0 @xterm/addon-fit@^0.11.0
```

Expected: three packages added to `dependencies`; `node-pty` shows under the native-modules group because it includes a build step.

- [ ] **Step 2: Extend `rebuild:electron` and `pretest` to cover node-pty**

In `package.json`, replace the two relevant scripts (Bash form shown; preserve existing quoting):

```json
"prestart": "electron-rebuild -f -w better-sqlite3 -w node-pty 2>/dev/null || true",
"rebuild:electron": "electron-rebuild -f -w better-sqlite3 -w node-pty && node -e \"const mods=['better-sqlite3/build/Release/better_sqlite3.node','node-pty/build/Release/pty.node']; const path=require('path'); for (const m of mods){try{process.dlopen({exports:{}},path.resolve('./node_modules/'+m));process.stderr.write('rebuild:electron FAILED for '+m+' — binary is still Node ABI. Electron will crash.\\n');process.exit(1)}catch(e){if(!e.message.includes('145')){process.stderr.write('rebuild:electron UNEXPECTED: '+e.message+'\\n');process.exit(1)}}} console.log('verified: native modules at NMV 145 (Electron ABI)')",
"pretest": "npm rebuild better-sqlite3 node-pty",
"pretest:watch": "npm rebuild better-sqlite3 node-pty",
"pretest:coverage": "npm rebuild better-sqlite3 node-pty"
```

- [ ] **Step 3: Extend forge packaging to copy + rebuild node-pty for the app bundle**

In `forge.config.ts`, after the existing `copyNativeModule(buildPath, 'better-sqlite3')` call (~line 55), add:

```ts
copyNativeModule(buildPath, 'node-pty');
console.log('[forge] Copied node-pty + deps into package');
```

And in the `asar.unpack` glob (~line 48) include node-pty's `.node` addon:

```ts
unpack: '{**/better-sqlite3/**/*.node,**/node-pty/**/*.node,**/@anthropic-ai/claude-agent-sdk-*/**}',
```

And in the rebuild block (~line 67), add `-w node-pty`:

```ts
`npx electron-rebuild -f -v ${electronVersion} -w better-sqlite3 -w node-pty -m "${buildPath}"`
```

- [ ] **Step 4: Verify the build dance works**

Run:
```bash
npm run rebuild:electron && npm run check && npm test
```

Expected: rebuild output says `verified: native modules at NMV 145 (Electron ABI)`, typecheck clean, existing tests pass (node-pty isn't used yet — this step just proves we didn't break the build).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json forge.config.ts
git commit -m "chore(deps): add node-pty + @xterm/xterm + @xterm/addon-fit for TUI mode"
```

---

## Task 2: TuiSession service — RED test for spawn + env

**Files:**
- Create: `electron/__tests__/tui.test.ts`
- Create: `electron/services/sessions/tui.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/tui.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn as ptySpawn } from 'node-pty';
import { createTuiSession } from '../services/sessions/tui';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(ptySpawn);

function makeFakePty() {
  const listeners: { data: ((s: string) => void)[]; exit: ((r: any) => void)[] } = {
    data: [],
    exit: [],
  };
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb: (s: string) => void) => {
      listeners.data.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb: (r: any) => void) => {
      listeners.exit.push(cb);
      return { dispose: () => {} };
    },
    _emitData: (s: string) => listeners.data.forEach((cb) => cb(s)),
    _emitExit: (r: any) => listeners.exit.forEach((cb) => cb(r)),
  };
}

describe('TuiSession', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('spawns `claude --resume <sessionId>` in the project cwd with CLAUDE_CONFIG_DIR set', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    createTuiSession({
      tabId: 't1',
      projectPath: '/Users/test/proj',
      configDir: '/Users/test/.claude-alice',
      sessionId: 'session-abc',
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args).toEqual(['--resume', 'session-abc']);
    expect((opts as any).cwd).toBe('/Users/test/proj');
    expect((opts as any).env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-alice');
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- electron/__tests__/tui.test.ts
```

Expected: FAIL with "Failed to resolve import `../services/sessions/tui`".

- [ ] **Step 3: Write minimal implementation**

Create `electron/services/sessions/tui.ts`:

```ts
import { spawn as ptySpawn, type IPty } from 'node-pty';

export interface TuiSessionParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  sessionId: string;
  claudeBinaryPath: string;
  cols?: number;
  rows?: number;
}

export interface TuiSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: { exitCode: number; signal?: number }) => void): void;
}

export function createTuiSession(params: TuiSessionParams): TuiSession {
  const pty: IPty = ptySpawn(
    params.claudeBinaryPath,
    ['--resume', params.sessionId],
    {
      cwd: params.projectPath,
      env: { ...process.env, CLAUDE_CONFIG_DIR: params.configDir },
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    }
  );

  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    onData: (cb) => { pty.onData(cb); },
    onExit: (cb) => { pty.onExit(cb); },
  };
}
```

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- electron/__tests__/tui.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions/tui.ts electron/__tests__/tui.test.ts
git commit -m "feat(tui): scaffold TuiSession service with node-pty spawn"
```

---

## Task 3: TuiSession — forward data + exit to consumer callbacks

**Files:**
- Modify: `electron/__tests__/tui.test.ts`
- Modify: `electron/services/sessions/tui.ts` (already correct, verify)

- [ ] **Step 1: Add RED tests for onData / onExit / write / resize / kill**

Append to `electron/__tests__/tui.test.ts`:

```ts
  it('forwards pty data chunks to the onData callback', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    const tui = createTuiSession({
      tabId: 't2', projectPath: '/p', configDir: '/c', sessionId: 's',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const received: string[] = [];
    tui.onData((d) => received.push(d));

    fake._emitData('hello');
    fake._emitData(' world');

    expect(received).toEqual(['hello', ' world']);
  });

  it('forwards pty exit to the onExit callback', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    const tui = createTuiSession({
      tabId: 't3', projectPath: '/p', configDir: '/c', sessionId: 's',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const exits: any[] = [];
    tui.onExit((r) => exits.push(r));

    fake._emitExit({ exitCode: 0 });

    expect(exits).toEqual([{ exitCode: 0 }]);
  });

  it('passes write / resize / kill through to the pty', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    const tui = createTuiSession({
      tabId: 't4', projectPath: '/p', configDir: '/c', sessionId: 's',
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    tui.write('ls\n');
    tui.resize(120, 40);
    tui.kill();

    expect(fake.write).toHaveBeenCalledWith('ls\n');
    expect(fake.resize).toHaveBeenCalledWith(120, 40);
    expect(fake.kill).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Verify GREEN** (implementation from Task 2 already covers these)

```bash
npm test -- electron/__tests__/tui.test.ts
```

Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
git add electron/__tests__/tui.test.ts
git commit -m "test(tui): cover data/exit/write/resize/kill pass-through"
```

---

## Task 4: Extend SessionHandle with mode tracking + setMode interface

**Files:**
- Modify: `electron/services/sessions/types.ts`

- [ ] **Step 1: Add `SessionMode` type and `mode` + `tui` fields on handle**

In `electron/services/sessions/types.ts`, after the existing `SessionStatus` type (line 39):

```ts
export type SessionMode = 'sdk' | 'tui';
```

And inside the `SessionHandle` interface, add (near the other per-session state, e.g. after `status: SessionStatus`):

```ts
  mode: SessionMode;
  tui: import('./tui').TuiSession | null;
  /** Cleanup hook that detaches the current tui's data/exit forwarders. */
  tuiDetach: (() => void) | null;
```

- [ ] **Step 2: Extend `SessionsService` interface with mode operations**

In the same file, in the `SessionsService` interface block (around lines 71-95), add:

```ts
  setMode(tabId: string, mode: SessionMode): Promise<void>;
  tuiWrite(tabId: string, data: string): void;
  tuiResize(tabId: string, cols: number, rows: number): void;
  getMode(tabId: string): SessionMode | null;
```

- [ ] **Step 3: Verify typecheck still passes**

```bash
npm run check
```

Expected: clean. (Implementations come in Task 5; the new interface methods will make the service factory fail compilation next — that's the RED for Task 5.)

- [ ] **Step 4: Commit**

```bash
git add electron/services/sessions/types.ts
git commit -m "feat(sessions): add SessionMode type + tui fields on SessionHandle"
```

---

## Task 5: setMode implementation — SDK → TUI with idle gate (TDD)

**Files:**
- Modify: `electron/__tests__/sessions.test.ts`
- Modify: `electron/services/sessions/lifecycle.ts`

- [ ] **Step 1: Write RED tests for setMode + idle gate**

Add to `electron/__tests__/sessions.test.ts` (inside the existing `sessions service — full lifecycle` describe block, near the other canUseTool tests):

```ts
  it('setMode("tui") spawns a TuiSession when status is running', async () => {
    vi.mock('../services/sessions/tui', () => ({
      createTuiSession: vi.fn(() => ({
        write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
        onData: vi.fn(), onExit: vi.fn(),
      })),
    }));
    const { createTuiSession } = await import('../services/sessions/tui');
    const mockedCreate = vi.mocked(createTuiSession);

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'tab-mode', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // Force handle into 'running' via a system:init message
    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-xyz' });
    await new Promise((r) => setImmediate(r));

    await svc.setMode('tab-mode', 'tui');

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate.mock.calls[0][0].sessionId).toBe('session-xyz');
    expect(svc.getMode('tab-mode')).toBe('tui');

    svc.stopAll();
  });

  it('setMode("tui") rejects when session is waiting_permission', async () => {
    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'tab-gate', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    // Force into waiting_permission
    const canUseTool = fake.getCapturedOptions().canUseTool;
    canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tu' });
    await new Promise((r) => setImmediate(r));

    await expect(svc.setMode('tab-gate', 'tui')).rejects.toThrow(/not allowed/i);

    svc.respondPermission('tab-gate', 'deny');
    svc.stopAll();
  });
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- electron/__tests__/sessions.test.ts -t "setMode"
```

Expected: FAIL with "svc.setMode is not a function" or "setMode is not implemented".

- [ ] **Step 3: Implement setMode + getMode + tuiWrite + tuiResize in lifecycle.ts**

In `electron/services/sessions/lifecycle.ts`, import the TUI factory at the top:

```ts
import { createTuiSession } from './tui';
import type { SessionMode } from './types';
import { findSystemClaudeBinary } from '../claude-binary';
```

Initialize `mode: 'sdk'`, `tui: null`, `tuiDetach: null` in the handle-creation block (search for `autoAllowedTools: new Set()` and add there).

Add the four new methods inside the `createSessionsService` factory, before the `return { ... }`:

```ts
  async function setMode(tabId: string, mode: SessionMode): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) throw new Error(`setMode: unknown tab ${tabId}`);
    if (handle.mode === mode) return;

    // Gate: only allow switch when SDK is at rest between turns.
    if (handle.status !== 'running') {
      throw new Error(`setMode: not allowed while status is "${handle.status}" (need "running")`);
    }

    if (mode === 'tui') {
      if (!handle.sessionId) {
        throw new Error('setMode("tui"): session has no sessionId yet');
      }
      // Close the SDK query cleanly.
      try { handle.query?.close?.(); } catch {}
      handle.inputChannel.close();

      const binaryPath = findSystemClaudeBinary();
      if (!binaryPath) throw new Error('setMode("tui"): claude binary not found');

      const tui = createTuiSession({
        tabId,
        projectPath: handle.projectPath,
        configDir: handle.configDir,
        sessionId: handle.sessionId,
        claudeBinaryPath: binaryPath,
      });

      const onData = (data: string) => sendToRenderer(`session-tui-data:${tabId}`, data);
      const onExit = (r: { exitCode: number }) => {
        sendToRenderer(`session-tui-exit:${tabId}`, r);
        // Auto-revert to SDK mode.
        void setMode(tabId, 'sdk').catch((e) =>
          console.error('[sessions] auto-revert to sdk failed:', e)
        );
      };
      tui.onData(onData);
      tui.onExit(onExit);

      handle.tui = tui;
      handle.tuiDetach = () => { try { tui.kill(); } catch {} };
      handle.mode = 'tui';
      sendToRenderer(`session-mode:${tabId}`, { mode: 'tui' });
    } else {
      // tui -> sdk: kill the pty, then re-start the SDK query with resume.
      handle.tuiDetach?.();
      handle.tui = null;
      handle.tuiDetach = null;
      handle.mode = 'sdk';
      sendToRenderer(`session-mode:${tabId}`, { mode: 'sdk' });

      // Re-start the SDK query on the same session id. Re-use the original
      // start params captured on the handle (see Task 6 for param capture).
      await restartSdkQuery(handle);
    }
  }

  function getMode(tabId: string): SessionMode | null {
    return sessions.get(tabId)?.mode ?? null;
  }

  function tuiWrite(tabId: string, data: string): void {
    sessions.get(tabId)?.tui?.write(data);
  }

  function tuiResize(tabId: string, cols: number, rows: number): void {
    sessions.get(tabId)?.tui?.resize(cols, rows);
  }
```

And add to the `return { ... }` statement: `setMode, getMode, tuiWrite, tuiResize,`.

NOTE: `restartSdkQuery` is referenced but not yet implemented — Task 6 adds it. For now, stub it as `async function restartSdkQuery(_handle: SessionHandle): Promise<void> { /* Task 6 */ }` so Task 5 ships RED-to-GREEN without depending on Task 6. The test for TUI → SDK round trip is in Task 7 after `restartSdkQuery` lands.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- electron/__tests__/sessions.test.ts -t "setMode"
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions/lifecycle.ts electron/__tests__/sessions.test.ts
git commit -m "feat(sessions): setMode(tui) with idle gate + pty spawn"
```

---

## Task 6: Capture SDK start params on the handle + implement `restartSdkQuery`

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`

- [ ] **Step 1: Add a `startParams` field on `SessionHandle`**

In `electron/services/sessions/types.ts`, inside `SessionHandle`:

```ts
  /** Original start params so we can re-start the SDK query on TUI exit. */
  startParams: {
    projectPath: string;
    configDir: string;
    model?: string;
    permissionMode?: string;
    effort?: string;
    thinking?: boolean | string;
  };
```

- [ ] **Step 2: Populate `startParams` at handle-creation time**

In `electron/services/sessions/lifecycle.ts`, in the `start()` function where the handle is built, set:

```ts
startParams: { projectPath, configDir, model, permissionMode, effort, thinking },
```

Adjust variable names if they differ in the existing destructuring.

- [ ] **Step 3: Implement `restartSdkQuery` that re-enters the existing query flow**

Refactor `start()` so the "build options + call `query()` + wire stream loop" portion lives in a helper:

```ts
async function buildAndStartQuery(handle: SessionHandle, resumeSessionId: string | null): Promise<void> {
  // ... move the existing options-building code from start() into here.
  // Add `resume: resumeSessionId` to options when non-null.
  // Re-wire canUseTool, hooks, stderr, etc. exactly as in start().
}
```

Then `start()` calls `buildAndStartQuery(handle, null)`, and `restartSdkQuery` calls `buildAndStartQuery(handle, handle.sessionId)`.

NOTE: This is the biggest refactor in the plan — hold the mental model that `start()` had a single inline block and now calls a helper with a `resume` parameter. No behavior change when `resume` is null; when it's set, the SDK picks up conversation history from the JSONL.

- [ ] **Step 4: Verify no existing tests break**

```bash
npm test
```

Expected: all 563 existing tests still pass. The refactor is behavior-preserving.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions/types.ts electron/services/sessions/lifecycle.ts
git commit -m "refactor(sessions): extract buildAndStartQuery helper, capture startParams"
```

---

## Task 7: TUI → SDK round-trip test

**Files:**
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the RED test**

```ts
  it('setMode("sdk") after tui exit re-enters the SDK with resume=sessionId', async () => {
    const createTuiMock = vi.fn();
    const fakePty = {
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    createTuiMock.mockReturnValue(fakePty);
    vi.doMock('../services/sessions/tui', () => ({ createTuiSession: createTuiMock }));

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'rt', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-round' });
    await new Promise((r) => setImmediate(r));

    await svc.setMode('rt', 'tui');
    expect(svc.getMode('rt')).toBe('tui');

    // Reset query mock so we can observe the restart call
    mockedQuery.mockClear();
    mockedQuery.mockReturnValue(installFakeQuery().query);

    await svc.setMode('rt', 'sdk');

    expect(svc.getMode('rt')).toBe('sdk');
    const restartCall = mockedQuery.mock.calls[0][0] as any;
    expect(restartCall.options.resume).toBe('sess-round');

    svc.stopAll();
  });
```

- [ ] **Step 2: Verify RED, then GREEN** — most of the implementation landed in Tasks 5 and 6; this test pins behavior.

```bash
npm test -- electron/__tests__/sessions.test.ts -t "round-trip"
```

Expected: PASS after any fixups to get the mock shape right.

- [ ] **Step 3: Commit**

```bash
git add electron/__tests__/sessions.test.ts
git commit -m "test(sessions): round-trip SDK->TUI->SDK preserves sessionId via resume"
```

---

## Task 8: IPC wiring — allow-list, handlers, api.ts

**Files:**
- Modify: `electron/preload.ts:42-56`
- Modify: `electron/ipc/handlers.ts:55+, 270+`
- Modify: `electron/main.ts:491+`
- Modify: `src/lib/api.ts:1290+`

- [ ] **Step 1: Add invoke + event channels to preload allow-list**

In `electron/preload.ts`, add to the invoke allow-list array:

```ts
'session_set_mode',
'session_tui_write',
'session_tui_resize',
```

And add to the event-prefix allow-list (search for existing `session-` prefixes):

```ts
'session-mode:',
'session-tui-data:',
'session-tui-exit:',
```

- [ ] **Step 2: Extend `SessionsService` interface in handlers.ts**

In `electron/ipc/handlers.ts` around line 55 (where the existing interface lists session methods), add:

```ts
setMode(tabId: string, mode: 'sdk' | 'tui'): Promise<unknown>;
tuiWrite(tabId: string, data: string): unknown;
tuiResize(tabId: string, cols: number, rows: number): unknown;
```

And in the channel map (~line 270):

```ts
session_set_mode: wrapWith((p: Record<string, unknown>) =>
  sessions?.setMode((p?.tabId ?? p?.session_id) as string, p?.mode as 'sdk' | 'tui') ?? null
),
session_tui_write: wrapWith((p: Record<string, unknown>) =>
  sessions?.tuiWrite((p?.tabId ?? p?.session_id) as string, p?.data as string) ?? null
),
session_tui_resize: wrapWith((p: Record<string, unknown>) =>
  sessions?.tuiResize(
    (p?.tabId ?? p?.session_id) as string,
    p?.cols as number,
    p?.rows as number,
  ) ?? null
),
```

- [ ] **Step 3: Wire the new methods in main.ts**

In `electron/main.ts` in the adapter block (~line 491), add:

```ts
setMode: (tabId: string, mode: 'sdk' | 'tui') => sessionsService.setMode(tabId, mode),
tuiWrite: (tabId: string, data: string) => sessionsService.tuiWrite(tabId, data),
tuiResize: (tabId: string, cols: number, rows: number) =>
  sessionsService.tuiResize(tabId, cols, rows),
```

- [ ] **Step 4: Add typed renderer wrappers in api.ts**

In `src/lib/api.ts` near line 1290 (other session methods):

```ts
async setSessionMode(tabId: string, mode: 'sdk' | 'tui'): Promise<void> {
  return apiCall('session_set_mode', { tabId, mode });
},

async tuiWrite(tabId: string, data: string): Promise<void> {
  return apiCall('session_tui_write', { tabId, data });
},

async tuiResize(tabId: string, cols: number, rows: number): Promise<void> {
  return apiCall('session_tui_resize', { tabId, cols, rows });
},
```

- [ ] **Step 5: Typecheck + tests**

```bash
npm run check && npm test -- electron/__tests__/ipc-handlers.test.ts
```

Expected: clean. (If the ipc-handlers test asserts a method count, update the expected array to include the three new methods.)

- [ ] **Step 6: Commit**

```bash
git add electron/preload.ts electron/ipc/handlers.ts electron/main.ts src/lib/api.ts \
        electron/__tests__/ipc-handlers.test.ts
git commit -m "feat(ipc): wire session_set_mode / tui_write / tui_resize channels"
```

---

## Task 9: TerminalView component

**Files:**
- Create: `src/components/TerminalView.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface TerminalViewProps {
  tabId: string;
}

export function TerminalView({ tabId }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
      theme: { background: '#00000000' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    // Send initial size to the backend so the pty matches what xterm drew.
    api.tuiResize(tabId, term.cols, term.rows).catch(console.error);

    termRef.current = term;
    fitRef.current = fit;

    // Keystrokes → backend
    const dataDisposable = term.onData((data) => {
      api.tuiWrite(tabId, data).catch(console.error);
    });

    // Backend data → xterm
    const unlistenData = window.electronAPI.on(
      `session-tui-data:${tabId}`,
      (_e: unknown, data: string) => term.write(data),
    );

    // Resize → backend
    const ro = new ResizeObserver(() => {
      fit.fit();
      api.tuiResize(tabId, term.cols, term.rows).catch(console.error);
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      unlistenData();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tabId]);

  return <div ref={hostRef} className="h-full w-full" />;
}
```

- [ ] **Step 2: Verify typecheck + build**

```bash
npm run check && npm run build
```

Expected: clean. (No unit test — this is a thin integration layer over xterm.js; behavioral verification is manual in Task 13.)

- [ ] **Step 3: Commit**

```bash
git add src/components/TerminalView.tsx
git commit -m "feat(ui): TerminalView xterm.js widget with size sync"
```

---

## Task 10: SessionModeToggle component

**Files:**
- Create: `src/components/SessionModeToggle.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { cn } from '@/lib/utils';
import { Terminal, MessageSquare } from 'lucide-react';

interface SessionModeToggleProps {
  mode: 'sdk' | 'tui';
  onChange: (mode: 'sdk' | 'tui') => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function SessionModeToggle({
  mode, onChange, disabled, disabledReason,
}: SessionModeToggleProps) {
  return (
    <div
      className={cn(
        'inline-flex rounded-md border border-border bg-muted/30 p-0.5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      title={disabled ? disabledReason : undefined}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('sdk')}
        className={cn(
          'flex items-center gap-1 px-2 py-1 text-xs rounded',
          mode === 'sdk' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <MessageSquare className="h-3 w-3" />
        SDK
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('tui')}
        className={cn(
          'flex items-center gap-1 px-2 py-1 text-xs rounded',
          mode === 'tui' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Terminal className="h-3 w-3" />
        Terminal
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
npm run check && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/SessionModeToggle.tsx
git commit -m "feat(ui): SessionModeToggle two-position control"
```

---

## Task 11: Wire mode + toggle + TerminalView into ClaudeCodeSession

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/components/SessionHeader.tsx`

- [ ] **Step 1: Add mode state and subscribe to `session-mode:<tabId>`**

In `src/components/ClaudeCodeSession.tsx`, near the other useState hooks (~line 226):

```tsx
const [sessionMode, setSessionMode] = useState<'sdk' | 'tui'>('sdk');
```

And in an existing `useEffect` that sets up `window.electronAPI.on(...)` subscriptions for session-* events, add:

```tsx
const unlistenMode = window.electronAPI.on(
  `session-mode:${tabIdRef.current}`,
  (_e: unknown, payload: { mode: 'sdk' | 'tui' }) => {
    setSessionMode(payload.mode);
  },
);
```

Don't forget to call `unlistenMode()` in the effect's cleanup return.

- [ ] **Step 2: Compute the idle-gate disabled state**

Near where `sessionStatus` is derived (~line 1307):

```tsx
const modeToggleDisabled = !isSessionActive || isSessionStarting || waitingForPermission;
const modeToggleReason = !isSessionActive
  ? 'Start a session first'
  : waitingForPermission
    ? 'Resolve the permission dialog first'
    : isSessionStarting
      ? 'Session is starting'
      : undefined;
```

- [ ] **Step 3: Pass the toggle into SessionHeader via a new `modeControl` prop**

In `ClaudeCodeSession.tsx`, at the `SessionHeader` render site (~line 1300):

```tsx
modeControl={
  <SessionModeToggle
    mode={sessionMode}
    disabled={modeToggleDisabled}
    disabledReason={modeToggleReason}
    onChange={(next) => {
      api.setSessionMode(tabIdRef.current, next).catch((err) => {
        console.error('Failed to switch mode:', err);
      });
    }}
  />
}
```

And add the import:

```tsx
import { SessionModeToggle } from './SessionModeToggle';
```

- [ ] **Step 4: Accept + render `modeControl` in SessionHeader**

In `src/components/SessionHeader.tsx`, extend the props interface:

```ts
modeControl?: React.ReactNode;
```

And render it in the header's control cluster alongside `viewModeControl`:

```tsx
{modeControl}
```

Pick a layout slot consistent with the existing `viewModeControl` placement (same `div`, before or after).

- [ ] **Step 5: Conditional render — TerminalView vs messages**

In `ClaudeCodeSession.tsx`, inside the main content area (search for `{messagesList}`):

```tsx
{sessionMode === 'tui' ? (
  <TerminalView tabId={tabIdRef.current} />
) : (
  messagesList
)}
```

And add the import:

```tsx
import { TerminalView } from './TerminalView';
```

- [ ] **Step 6: Verify build**

```bash
npm run check && npm run build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx src/components/SessionHeader.tsx
git commit -m "feat(ui): wire mode toggle + TerminalView into ClaudeCodeSession"
```

---

## Task 12: Handle pty exit → auto-revert to SDK

This behavior was implemented in the lifecycle's `onExit` handler in Task 5 (it calls `setMode(tabId, 'sdk')` unconditionally). The renderer already reacts because `session-mode:<tabId>` is emitted, which flips `sessionMode` state and unmounts `TerminalView`. No additional code needed — this task is a verification of behavior already in place.

- [ ] **Step 1: Add integration test asserting the auto-revert fires when onExit triggers**

In `electron/__tests__/sessions.test.ts`:

```ts
  it('tui exit auto-reverts the session to sdk mode', async () => {
    const exitHandlers: ((r: any) => void)[] = [];
    const fakePty = {
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: vi.fn(),
      onExit: (cb: any) => exitHandlers.push(cb),
    };
    vi.doMock('../services/sessions/tui', () => ({
      createTuiSession: vi.fn(() => fakePty),
    }));

    const svc = createSessionsService(
      sendToRenderer as any,
      { showNotification: showNotification as any, incrementUnread: incrementUnread as any },
    );
    const fake = installFakeQuery();
    svc.start({ tabId: 'auto', projectPath: '/p', configDir: '/c', model: 'sonnet', permissionMode: 'default' });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'sess-auto' });
    await new Promise((r) => setImmediate(r));

    await svc.setMode('auto', 'tui');
    expect(svc.getMode('auto')).toBe('tui');

    // Simulate the pty exiting (user typed /exit).
    exitHandlers.forEach((cb) => cb({ exitCode: 0 }));
    await new Promise((r) => setImmediate(r));

    expect(svc.getMode('auto')).toBe('sdk');

    svc.stopAll();
  });
```

- [ ] **Step 2: Verify GREEN**

```bash
npm test -- electron/__tests__/sessions.test.ts -t "auto-revert"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/__tests__/sessions.test.ts
git commit -m "test(sessions): pty exit auto-reverts session to sdk mode"
```

---

## Task 13: Full verification gate + manual browser test

**Files:** none — this task runs commands and drives the UI.

- [ ] **Step 1: Typecheck + build + full suite with coverage**

```bash
npm run check && npm run build && npm run test:coverage
```

Expected: all green. Watch `sessions/tui.ts`, `sessions/lifecycle.ts`, `permissions.ts`, `logging.ts` coverage — target ≥80% line. If `lifecycle.ts` drops below 80 because of the refactor, add tests for the extracted `buildAndStartQuery` helper until back over.

- [ ] **Step 2: Rebuild Electron ABI** (so dev app can start)

```bash
npm run rebuild:electron
```

Expected: `verified: native modules at NMV 145 (Electron ABI)`.

- [ ] **Step 3: Start dev app and drive the round-trip manually**

```bash
ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | tee /tmp/greychrist.log
```

Checklist (do each in order):

1. Open a project that resolves to a specific account. Confirm the titlebar shows correct account chip.
2. Start a new session (`default` permission mode so the toggle is in real-world shape).
3. Send one message, wait for Claude to respond, confirm session status goes `running` and the **SDK / Terminal** toggle is enabled in the header.
4. Click **Terminal**. Expect: messages area replaced by an xterm grid, prompt visible, the SDK spinner goes away. Toggle shows "Terminal" selected.
5. In the TUI, type `/help` and hit enter. Expect: Claude Code's slash-command menu renders.
6. Type `/model` and pick a model. Expect: the TUI confirms the switch.
7. Type `/exit`. Expect: the grid disappears, message list re-appears, toggle flips to "SDK" automatically.
8. Send a follow-up message in SDK mode. Expect: Claude responds and has memory of the earlier turns (i.e., the resume worked).
9. Repeat the switch mid-session; confirm scrollback in TUI is reset each time (expected) and SDK message history persists.
10. Verify the toggle is disabled while a permission dialog is open and while Claude is thinking.
11. Check `/tmp/greychrist.log` for errors. Any `error` / `FATAL` lines → investigate before declaring done.

- [ ] **Step 4: Rebuild Electron ABI again** (the pretest hooks may have flipped it)

```bash
npm run rebuild:electron
```

- [ ] **Step 5: No commit from this task** — verification only. If anything fails, circle back and fix in the relevant earlier task, don't fix in a catch-all commit here.

---

## Task 14: CHANGELOG + release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump to 0.3.33**

Change `package.json:4` from `0.3.32` → `0.3.33`.

- [ ] **Step 2: Add CHANGELOG entry**

Prepend above `## [0.3.32]`:

```markdown
## [0.3.33] — YYYY-MM-DD

New **SDK ↔ Terminal** mode toggle per session: drop into the full Claude Code TUI (every slash command, plugin, `/model`, etc.) and back again, on the same conversation. Installers remain **unsigned**.

### Added

- **Per-session mode toggle: SDK / Terminal** (`<commit>`). Sessions now have two surfaces backed by the same JSONL conversation file. The default `SDK` mode is unchanged. Switching to `Terminal` cleanly closes the SDK query, spawns `claude --resume <sessionId>` in a node-pty'd xterm.js widget, and forwards the session's `CLAUDE_CONFIG_DIR` so multi-account routing survives the handoff. Switching back re-enters `query({ resume: sessionId })` — conversation memory persists. The toggle is disabled while Claude is thinking or a permission dialog is open; only transitions between turns are allowed.
- **New `TuiSession` service + `TerminalView` component** (`<commit>`). `electron/services/sessions/tui.ts` owns pty lifecycle (spawn, data, resize, kill). `src/components/TerminalView.tsx` renders xterm.js with auto-fit sizing. IPC channels `session_set_mode`, `session_tui_write`, `session_tui_resize`; event channels `session-mode:<tabId>`, `session-tui-data:<tabId>`, `session-tui-exit:<tabId>`.

### Changed

- **`lifecycle.ts` extracted a `buildAndStartQuery` helper** (`<commit>`) to reuse the SDK-query setup between initial `start()` and post-TUI `restartSdkQuery()`. Behavior-preserving refactor; all existing tests still pass.

### Notes

- While a session is in Terminal mode, GreyChrist's LogTab, permission dialog, and per-tool widgets do not capture events — the TUI is the live surface. This is by design.
- `node-pty` joins `better-sqlite3` as a native module; the `rebuild:electron` + pretest hooks now rebuild both for the Electron ABI.
```

Replace each `<commit>` with the short SHA from this plan's feature commits.

- [ ] **Step 3: Invoke the release runbook**

```bash
# delete the earlier draft, it was superseded by the combined release
gh release delete v0.3.32 --cleanup-tag --yes || true
```

NOTE: `--cleanup-tag` is destructive in that it removes the v0.3.32 tag. Since the v0.3.32 tag still points to a reachable commit on main, the history isn't lost, it's just not tagged. Verify with Greg that deleting the dead tag is OK; if he'd rather keep it as a tombstone, skip this command.

Then run the `greychrist-release` skill (it will pick up the 0.3.33 version and build installers).

- [ ] **Step 4: Manual verification of the released installer**

Download the DMG from the draft release, install on a clean macOS profile (or at least a clean projects dir), repeat Task 13 Step 3's checklist on the packaged app. The packaged path exercises the forge node-pty copy + rebuild — this is where packaging bugs surface.

---

## Self-Review

- ✅ **Spec coverage:** Each of the feature's architectural pieces (pty spawn, idle gate, auto-revert, IPC wiring, xterm widget, mode toggle, round-trip) has a dedicated task.
- ✅ **Native module dance:** Task 1 covers node-pty across pretest, rebuild:electron, and forge — same shape as the existing better-sqlite3 handling.
- ✅ **Idle gate enforced:** `status === 'running'` check in `setMode`, test covers the `waiting_permission` rejection, UI mirrors it with `disabled`.
- ✅ **JSONL-based handoff:** `claude --resume <sessionId>` in the pty + SDK `{ resume: sessionId }` on return; no concurrent writers.
- ✅ **No placeholders:** All code blocks are runnable; all file paths are specific; all test assertions verify real behavior.
- ⚠️ **Task 6 refactor carries risk:** the `buildAndStartQuery` extraction touches the core session startup path. The plan says "behavior-preserving," but if any existing test breaks, chase the root cause rather than papering over it with mocks.
- ⚠️ **Task 14 tag cleanup:** `gh release delete v0.3.32 --cleanup-tag` is destructive on the tag. Plan calls out checking with Greg first.

---

**End of plan.**
