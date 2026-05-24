# Terminal-Primary Session View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote OmniFex's existing TUI mode (PTY-spawned `claude` rendered in xterm.js) from a manual-toggle fallback to a first-class session view, with a 50/50 split that pairs the terminal with a rich `MessagePanel` rendered from the JSONL session file. This is Phase 1 toward surviving the upcoming monthly programmatic-credit cap on the Claude Agent SDK.

**Architecture:** Reuse the existing `node-pty`-backed `createTuiSession` and `setMode('tui'|'sdk')` plumbing. Add a cold-start path (`start({ mode: 'tui' })`) that spawns `claude` without `--resume` and discovers the new session's JSONL file by diffing the projects directory before/after spawn. Extend `createJsonlTail` with an `'all'` filter mode so it can drive a renderer-side `MessagePanel`. Extract the notification-dispatch logic from `runtime.ts` into a shared helper so JSONL-mode and SDK-mode use the same notification surface. The renderer gains `MessagePanel` and `TuiSessionLayout` (50/50 horizontal split); `ClaudeCodeSession.tsx` switches its layout based on `session-mode:<tabId>` events.

**Tech Stack:**
- Existing: `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@anthropic-ai/claude-agent-sdk`, React 18, Vitest
- New: `@xterm/addon-web-links` (clickable URLs in the terminal)

**Spec:** `docs/superpowers/specs/2026-05-23-terminal-primary-session-view-design.md`

**Repo conventions:** Per `CLAUDE.md`, commits happen only when Greg explicitly asks. Each task's "Commit" step is a checkpoint — the executing agent should pause and confirm before running `git commit`.

---

## Non-Goals (out of scope for Phase 1)

- ANSI screen-scraping of stdout
- Replacing terminal rendering with React (Flavor 4 from brainstorming)
- Auto-fallback from SDK to TUI on metering-rejection events
- Synchronized scroll between terminal and panel
- Gutter / decoration markers tying terminal lines to JSONL events
- Programmatic input adapter (paste-mode keystroke synthesis, multi-line, attachments)
- Mid-session structured permission UI in TUI mode (permissions stay in the terminal)
- Resume of existing TUI sessions started via cold-start with `resumeSessionId` — that path stays SDK-only for now

---

## File Structure

**New files:**
- `electron/services/sessions/tui-jsonl.ts` — Factory that owns the JSONL tail in TUI mode: forwards all parsed lines to `session-jsonl:<tabId>`, dispatches notifications on `result` events, and reports sessionId from the first `system:init` line.
- `electron/services/sessions/notifications.ts` — `dispatchResultNotification()` helper extracted from `runtime.ts:155-180`. Pure function over `(event, projectPath, tabId, deps)`.
- `electron/services/sessions/tui-coldstart.ts` — Helper that diffs the project's JSONL directory before/after PTY spawn to identify the newly-created session file.
- `electron/__tests__/sessions-notifications.test.ts` — Unit tests for the notification helper.
- `electron/__tests__/sessions-tui-jsonl.test.ts` — Unit tests for the TUI JSONL listener.
- `electron/__tests__/sessions-tui-coldstart.test.ts` — Unit tests for the cold-start discovery helper and the `start({ mode: 'tui' })` lifecycle entry.
- `src/components/MessagePanel.tsx` — Rich-card renderer driven by the `session-jsonl:<tabId>` event channel.
- `src/components/TuiSessionLayout.tsx` — 50/50 horizontal-split container hosting `TerminalView` and `MessagePanel`.

**Modified files:**
- `electron/services/sessions/jsonl-tail.ts` — Add `filter?: 'closure-carriers' | 'all'` option (default `'closure-carriers'`); branch line-forwarding logic on it.
- `electron/__tests__/jsonl-tail.test.ts` — Add tests for `filter: 'all'` and explicit `'closure-carriers'` paths.
- `electron/services/sessions/types.ts` — Make `SessionHandle.query` and `SessionHandle.inputChannel` nullable (TUI cold-start has neither); extend `SessionStartParams` with optional `mode?: SessionMode`.
- `electron/services/sessions/runtime.ts` — Use the new `dispatchResultNotification` helper.
- `electron/services/sessions/lifecycle.ts` — Branch `start()` on `params.mode`; gate query-using paths (`sendMessage`, `stop`) on `handle.query != null`.
- `electron/services/sessions/queries.ts` — Guard each passthrough with `if (!handle.query) return;` (TUI mode has no `Query` instance).
- `electron/services/sessions/factory.ts` — Export `findSystemClaudeBinary` (already exported, just confirm) so cold-start can use it.
- `electron/main.ts` — Pass `mode` parameter through the `session_start` IPC adapter.
- `electron/preload.ts` — No changes needed: `session-` event prefix already allowed, `session_start` invoke already allowed.
- `src/lib/api.ts` — Extend `startSession` signature with `mode?: 'sdk' | 'tui'`.
- `src/lib/apiAdapter.ts` — Pass `mode` through if not already generic.
- `src/components/ClaudeCodeSession.tsx` — Subscribe to `session-mode:<tabId>`; conditionally render `TuiSessionLayout` when mode is `'tui'`.
- `src/components/TerminalView.tsx` — Adopt OmniFex theme; add `@xterm/addon-web-links`.
- `src/components/NewSessionForm.tsx` (or equivalent) — Add a "Start in Terminal mode" option.
- `package.json` — Add `@xterm/addon-web-links` dependency.

---

## Task 1: Extend `createJsonlTail` with `filter: 'all'` mode

**Files:**
- Modify: `electron/services/sessions/jsonl-tail.ts`
- Modify: `electron/__tests__/jsonl-tail.test.ts`

The existing tail filters to closure carriers only. We need an `'all'` mode that forwards every parsed line, used by the new TUI JSONL listener.

- [ ] **Step 1: Write the failing test** in `electron/__tests__/jsonl-tail.test.ts` (append to the existing `describe('createJsonlTail', ...)` block):

```typescript
it('forwards every parsed line when filter is "all"', async () => {
  fs.writeFileSync(jsonlPath, '');
  tail = createJsonlTail({
    jsonlPath,
    filter: 'all',
    onMessage: (m) => received.push(m),
  });
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }) + '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n' +
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n',
  );
  await waitUntil(() => received.length >= 3);
  expect(received).toHaveLength(3);
  expect((received[0] as { type: string }).type).toBe('system');
  expect((received[1] as { type: string }).type).toBe('user');
  expect((received[2] as { type: string }).type).toBe('result');
});

it('ignores non-carrier lines when filter defaults to "closure-carriers"', async () => {
  fs.writeFileSync(jsonlPath, '');
  start();
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }) + '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
  );
  await wait(400);
  expect(received).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- electron/__tests__/jsonl-tail.test.ts`
Expected: the two new tests fail; the `'all'` test errors on the unknown `filter` field (or passes by accident if untyped) — adjust until it's clearly failing because nothing's filtered through.

- [ ] **Step 3: Implement the `filter` option** in `electron/services/sessions/jsonl-tail.ts`:

```typescript
export interface CreateJsonlTailArgs {
  jsonlPath: string;
  onMessage: (msg: unknown) => void;
  onError?: (err: unknown) => void;
  /**
   * Which parsed lines to forward. Defaults to `'closure-carriers'` so
   * existing SDK-mode call sites keep their narrow surface.
   * - `'closure-carriers'`: only `queue-operation`/`attachment` lines that
   *   carry `<task-notification>` XML (today's behavior).
   * - `'all'`: every parsed line, regardless of type. Used by TUI mode to
   *   drive the rich-message panel and notifications from JSONL.
   */
  filter?: 'closure-carriers' | 'all';
}
```

Then update the loop inside `drain()`:

```typescript
const shouldForward = filter === 'all' ? () => true : isClosureCarrier;
// ...
for (const line of lines) {
  if (!line) continue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  if (shouldForward(parsed)) {
    try {
      onMessage(parsed);
    } catch (err) {
      safeFire(err);
    }
  }
}
```

And destructure `filter = 'closure-carriers'` near the top of `createJsonlTail`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- electron/__tests__/jsonl-tail.test.ts`
Expected: all tests in the file pass, including pre-existing closure-carrier tests.

- [ ] **Step 5: Commit checkpoint**

```bash
git add electron/services/sessions/jsonl-tail.ts electron/__tests__/jsonl-tail.test.ts
git commit -m "feat(sessions): add 'all' filter mode to JSONL tail"
```

---

## Task 2: Extract notification dispatch into a shared helper

**Files:**
- Create: `electron/services/sessions/notifications.ts`
- Create: `electron/__tests__/sessions-notifications.test.ts`
- Modify: `electron/services/sessions/runtime.ts`

The block at `runtime.ts:155-180` builds the notification title, emits `claude-notification`, fires `notificationHooks.showNotification`, and increments unread. We extract it so both the SDK iterator and the new JSONL listener can call it.

- [ ] **Step 1: Write the failing test** in `electron/__tests__/sessions-notifications.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { dispatchResultNotification } from '../services/sessions/notifications';

describe('dispatchResultNotification', () => {
  it('emits claude-notification, fires showNotification, and increments unread on success', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn();
    const incrementUnread = vi.fn();

    dispatchResultNotification({
      tabId: 'tab-1',
      projectPath: '/Users/test/proj',
      event: { kind: 'result', isError: false, body: 'Task complete' },
      sendToRenderer,
      notificationHooks: { showNotification, incrementUnread },
    });

    expect(sendToRenderer).toHaveBeenCalledWith('claude-notification', {
      tab_id: 'tab-1',
      title: 'OmniFex — proj',
      body: 'Task complete',
      is_error: false,
    });
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — proj',
      'Task complete',
      false,
      { tabId: 'tab-1' },
    );
    expect(incrementUnread).toHaveBeenCalledTimes(1);
  });

  it('marks the notification as an error when the result event is an error', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn();

    dispatchResultNotification({
      tabId: 'tab-2',
      projectPath: '/p',
      event: { kind: 'result', isError: true, body: 'Task failed' },
      sendToRenderer,
      notificationHooks: { showNotification },
    });

    expect(sendToRenderer).toHaveBeenCalledWith('claude-notification', expect.objectContaining({ is_error: true }));
    expect(showNotification).toHaveBeenCalledWith(expect.any(String), 'Task failed', true, { tabId: 'tab-2' });
  });

  it('swallows hook errors without throwing', () => {
    const sendToRenderer = vi.fn();
    const showNotification = vi.fn(() => { throw new Error('boom'); });

    expect(() => dispatchResultNotification({
      tabId: 'tab-3',
      projectPath: '/p',
      event: { kind: 'result', isError: false, body: 'done' },
      sendToRenderer,
      notificationHooks: { showNotification },
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- electron/__tests__/sessions-notifications.test.ts`
Expected: FAIL with "Cannot find module '../services/sessions/notifications'"

- [ ] **Step 3: Implement the helper** in `electron/services/sessions/notifications.ts`:

```typescript
// Sessions module — notification dispatch
//
// Shared helper used by both the SDK iterator (runtime.ts) and the TUI-mode
// JSONL listener (tui-jsonl.ts). Extracted so both paths produce identical
// OS notifications / dock-badge updates / renderer notification events.

import path from 'node:path';
import type { NotificationHooks, SendToRenderer } from './types';
import type { RuntimeEvent } from './events';

export interface DispatchArgs {
  tabId: string;
  projectPath: string;
  event: Extract<RuntimeEvent, { kind: 'result' }>;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
}

export function dispatchResultNotification(args: DispatchArgs): void {
  const { tabId, projectPath, event, sendToRenderer, notificationHooks } = args;
  const projectName = path.basename(projectPath) || 'OmniFex';
  const title = `OmniFex — ${projectName}`;

  sendToRenderer('claude-notification', {
    tab_id: tabId,
    title,
    body: event.body,
    is_error: event.isError,
  });

  try {
    notificationHooks.showNotification?.(title, event.body, event.isError, { tabId });
    notificationHooks.incrementUnread?.();
  } catch (e) {
    console.error('[sessions] notification hook failed:', e);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- electron/__tests__/sessions-notifications.test.ts`
Expected: PASS — all three tests.

- [ ] **Step 5: Refactor `runtime.ts` to use the helper**

Replace the block at `electron/services/sessions/runtime.ts:155-180` (the `if (event.kind === 'result') { ... }` body up to `handle.status = 'idle';`) with:

```typescript
if (event.kind === 'result') {
  dispatchResultNotification({
    tabId,
    projectPath: handle.projectPath,
    event,
    sendToRenderer,
    notificationHooks,
  });
  handle.status = 'idle';
}
```

Add the import at the top of `runtime.ts`:

```typescript
import { dispatchResultNotification } from './notifications';
```

- [ ] **Step 6: Run the full backend test suite and confirm runtime behavior is unchanged**

Run: `npm test`
Expected: all existing tests pass. If any runtime-related test (`electron/__tests__/sessions-*`) breaks, the extraction missed a behavior — re-check the diff.

- [ ] **Step 7: Commit checkpoint**

```bash
git add electron/services/sessions/notifications.ts electron/services/sessions/runtime.ts electron/__tests__/sessions-notifications.test.ts
git commit -m "refactor(sessions): extract dispatchResultNotification helper"
```

---

## Task 3: Build the TUI JSONL listener

**Files:**
- Create: `electron/services/sessions/tui-jsonl.ts`
- Create: `electron/__tests__/sessions-tui-jsonl.test.ts`

The listener owns the JSONL tail in TUI mode. For each parsed line it:
- Forwards the raw object on `session-jsonl:<tabId>`
- Classifies the event; on `init`, calls back with sessionId; on `result`, fires the notification helper

- [ ] **Step 1: Write the failing test** in `electron/__tests__/sessions-tui-jsonl.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTuiJsonlListener, type TuiJsonlHandle } from '../services/sessions/tui-jsonl';

function wait(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(30);
  }
  return predicate();
}

describe('createTuiJsonlListener', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let handle: TuiJsonlHandle | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-tui-jsonl-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('forwards every parsed line on session-jsonl:<tabId>', async () => {
    const sendToRenderer = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-1',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer,
      notificationHooks: {},
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    await waitUntil(() => sendToRenderer.mock.calls.some(c => c[0] === 'session-jsonl:tab-1'));
    expect(sendToRenderer).toHaveBeenCalledWith('session-jsonl:tab-1', expect.objectContaining({ type: 'user' }));
  });

  it('reports sessionId via onInit when system:init lands', async () => {
    const onInit = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-2',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer: vi.fn(),
      notificationHooks: {},
      onInit,
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-xyz' }) + '\n',
    );
    await waitUntil(() => onInit.mock.calls.length > 0);
    expect(onInit).toHaveBeenCalledWith('sid-xyz');
  });

  it('fires the notification helper on a result line', async () => {
    const showNotification = vi.fn();
    const sendToRenderer = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-3',
      projectPath: '/Users/test/myproj',
      jsonlPath,
      sendToRenderer,
      notificationHooks: { showNotification },
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Task complete' }) + '\n',
    );
    await waitUntil(() => showNotification.mock.calls.length > 0);
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — myproj',
      'Task complete',
      false,
      { tabId: 'tab-3' },
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- electron/__tests__/sessions-tui-jsonl.test.ts`
Expected: FAIL with "Cannot find module '../services/sessions/tui-jsonl'"

- [ ] **Step 3: Implement the listener** in `electron/services/sessions/tui-jsonl.ts`:

```typescript
// Sessions module — TUI-mode JSONL listener
//
// Owns the JSONL tail for a TUI-mode session. The SDK iterator is not
// running in this mode, so JSONL is the only event source. The listener:
//   1. Forwards every parsed line on `session-jsonl:<tabId>` so the renderer
//      can populate the MessagePanel.
//   2. Classifies events; on `result`, fires the shared notification helper
//      so OS notifications / dock-badge updates work identically to SDK
//      mode.
//   3. Reports `system:init` via the `onInit` callback so the lifecycle
//      layer can capture sessionId for sessions started cold.

import { createJsonlTail, type JsonlTailHandle } from './jsonl-tail';
import { classifyRuntimeEvent } from './events';
import { dispatchResultNotification } from './notifications';
import type { NotificationHooks, SendToRenderer } from './types';

export interface CreateTuiJsonlListenerArgs {
  tabId: string;
  projectPath: string;
  jsonlPath: string;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
  /** Called with the sessionId from the first `system:init` line. */
  onInit: (sessionId: string) => void;
}

export interface TuiJsonlHandle {
  stop: () => void;
}

export function createTuiJsonlListener(args: CreateTuiJsonlListenerArgs): TuiJsonlHandle {
  const { tabId, projectPath, jsonlPath, sendToRenderer, notificationHooks, onInit } = args;

  const tail: JsonlTailHandle = createJsonlTail({
    jsonlPath,
    filter: 'all',
    onMessage: (msg) => {
      sendToRenderer(`session-jsonl:${tabId}`, msg);

      const event = classifyRuntimeEvent(msg);
      if (event.kind === 'init' && event.sessionId) {
        onInit(event.sessionId);
      } else if (event.kind === 'result') {
        dispatchResultNotification({
          tabId,
          projectPath,
          event,
          sendToRenderer,
          notificationHooks,
        });
      }
    },
    onError: (err) => {
      console.warn(`[sessions] tui-jsonl tail error (${tabId}):`, err);
    },
  });

  return {
    stop: () => tail.stop(),
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- electron/__tests__/sessions-tui-jsonl.test.ts`
Expected: PASS — all three tests.

- [ ] **Step 5: Commit checkpoint**

```bash
git add electron/services/sessions/tui-jsonl.ts electron/__tests__/sessions-tui-jsonl.test.ts
git commit -m "feat(sessions): TUI-mode JSONL listener"
```

---

## Task 4: TUI cold-start discovery helper

**Files:**
- Create: `electron/services/sessions/tui-coldstart.ts`
- Create: `electron/__tests__/sessions-tui-coldstart.test.ts`

When starting a brand-new session in TUI mode (no `--resume`), the CLI creates a new `<sessionId>.jsonl` file in `<configDir>/projects/<encoded-projectPath>/`. We don't know the sessionId until the file appears. This helper:
1. Snapshots the existing JSONL filenames in that directory before spawn
2. Polls for new entries after spawn
3. Resolves with the new file's full path (sessionId is the basename)

The encoding is `projectPath.replace(/\//g, '-')` — same as `runtime.ts:68`.

- [ ] **Step 1: Write the failing test** in `electron/__tests__/sessions-tui-coldstart.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverNewSessionFile } from '../services/sessions/tui-coldstart';

describe('discoverNewSessionFile', () => {
  let configDir: string;
  let projectsDir: string;
  const projectPath = '/Users/test/myproj';
  const encoded = '-Users-test-myproj';

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-coldstart-'));
    projectsDir = path.join(configDir, 'projects', encoded);
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolves with the new JSONL file when one appears after the snapshot', async () => {
    fs.writeFileSync(path.join(projectsDir, 'old-session.jsonl'), '');
    const discoveryP = discoverNewSessionFile({ configDir, projectPath, timeoutMs: 2000 });
    // Simulate the CLI creating a new file after spawn
    setTimeout(() => {
      fs.writeFileSync(path.join(projectsDir, 'new-session-uuid.jsonl'), '');
    }, 100);
    const result = await discoveryP;
    expect(result.sessionId).toBe('new-session-uuid');
    expect(result.jsonlPath).toBe(path.join(projectsDir, 'new-session-uuid.jsonl'));
  });

  it('creates the projects directory if missing', async () => {
    fs.rmSync(projectsDir, { recursive: true });
    const discoveryP = discoverNewSessionFile({ configDir, projectPath, timeoutMs: 2000 });
    setTimeout(() => {
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'first.jsonl'), '');
    }, 100);
    const result = await discoveryP;
    expect(result.sessionId).toBe('first');
  });

  it('rejects when no new file appears within the timeout', async () => {
    fs.writeFileSync(path.join(projectsDir, 'only.jsonl'), '');
    await expect(
      discoverNewSessionFile({ configDir, projectPath, timeoutMs: 300 })
    ).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- electron/__tests__/sessions-tui-coldstart.test.ts`
Expected: FAIL with "Cannot find module '../services/sessions/tui-coldstart'"

- [ ] **Step 3: Implement the helper** in `electron/services/sessions/tui-coldstart.ts`:

```typescript
// Sessions module — TUI cold-start discovery
//
// When starting a TUI session without `--resume`, the CLI mints a new
// sessionId and creates `<configDir>/projects/<encoded-projectPath>/<id>.jsonl`.
// We don't know the id until that file appears. This helper:
//   1. Records the set of existing JSONL filenames in the projects dir.
//   2. Polls every 100ms for new files.
//   3. Resolves with the basename (sessionId) and full path of the new file.
//
// Polling rather than fs.watch — same rationale as jsonl-tail.ts: fs.watch
// is unreliable on macOS, fs.watchFile uses polling under the hood, and our
// cost is one readdir per session-start per 100ms (negligible).

import fs from 'node:fs';
import path from 'node:path';

export interface DiscoverArgs {
  configDir: string;
  projectPath: string;
  /** Hard ceiling; rejects with a timeout error if no new file appears. */
  timeoutMs?: number;
}

export interface DiscoveryResult {
  sessionId: string;
  jsonlPath: string;
}

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

export function discoverNewSessionFile(args: DiscoverArgs): Promise<DiscoveryResult> {
  const { configDir, projectPath, timeoutMs = DEFAULT_TIMEOUT_MS } = args;
  const encoded = projectPath.replace(/\//g, '-');
  const projectsDir = path.join(configDir, 'projects', encoded);

  // Ensure the dir exists so readdirSync doesn't throw on the first tick.
  try { fs.mkdirSync(projectsDir, { recursive: true }); } catch { /* ignore */ }

  const baselineJsonls = listJsonls(projectsDir);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const current = listJsonls(projectsDir);
      const newFile = [...current].find((f) => !baselineJsonls.has(f));
      if (newFile) {
        clearInterval(poll);
        const sessionId = newFile.replace(/\.jsonl$/, '');
        resolve({ sessionId, jsonlPath: path.join(projectsDir, newFile) });
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(poll);
        reject(new Error(`TUI cold-start: timed out waiting for new JSONL in ${projectsDir}`));
      }
    }, POLL_INTERVAL_MS);
  });
}

function listJsonls(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- electron/__tests__/sessions-tui-coldstart.test.ts`
Expected: PASS — all three tests.

- [ ] **Step 5: Commit checkpoint**

```bash
git add electron/services/sessions/tui-coldstart.ts electron/__tests__/sessions-tui-coldstart.test.ts
git commit -m "feat(sessions): TUI cold-start session discovery"
```

---

## Task 5: Wire TUI cold-start into `start()`

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/services/sessions/queries.ts`
- Modify: `electron/services/sessions/runtime.ts`
- Create: additional tests in `electron/__tests__/sessions-tui-coldstart.test.ts`

Plumbing: `SessionStartParams` gains an optional `mode`. `SessionHandle.query` and `SessionHandle.inputChannel` become nullable. `start()` branches: if `mode === 'tui'`, we skip SDK creation and instead spawn the PTY + TUI JSONL listener directly. The handle is created with `query: null`, `inputChannel: null`.

- [ ] **Step 1: Extend the type** in `electron/services/sessions/types.ts`:

In `SessionStartParams`, add:

```typescript
  /**
   * Choose the session backend. Defaults to `'sdk'` (today's behavior).
   * `'tui'` spawns the CLI in a PTY without `--resume` and drives the
   * renderer from the session's JSONL file. Use TUI mode when programmatic
   * API budget is exhausted or the user prefers terminal-primary UX.
   */
  mode?: SessionMode;
```

In `SessionHandle`, change:

```typescript
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
```

to:

```typescript
  /** Null in TUI cold-start sessions (no SDK query). */
  query: Query | null;
  /** Null in TUI cold-start sessions (no SDK input channel). */
  inputChannel: AsyncChannel<SDKUserMessage> | null;
  /** Stop handle for the TUI JSONL listener (null in SDK mode). */
  tuiJsonl: import('./tui-jsonl').TuiJsonlHandle | null;
```

- [ ] **Step 2: Guard query-using passthroughs** in `electron/services/sessions/queries.ts`

Wrap every passthrough's body with an early return when `handle.query == null`. Example for `setModel` (apply the same pattern to `setPermissionMode`, `setEffort`, `setThinking`, `interrupt`, `applyPermissions`, `getAccountInfo`, `getContextUsage`, `getSupportedCommands`, `getSupportedModels`, `getSupportedAgents`, `getMcpServerStatus`, `getPlugins`):

```typescript
async function setModel(tabId: string, model?: string): Promise<void> {
  const handle = sessions.get(tabId);
  if (!handle) return;
  if (!handle.query) return; // TUI mode — no SDK query to mutate
  try {
    await handle.query.setModel(model);
  } catch (err) {
    console.error(`[sessions] setModel failed for tab ${tabId}:`, err);
  }
}
```

For `getSupportedCommands`/`getSupportedModels`/`getSupportedAgents`/`getMcpServerStatus`/`getPlugins`, return `[]` instead of `undefined`. For `getAccountInfo`/`getContextUsage`, return `null`.

- [ ] **Step 3: Guard `sendMessage`, `sendStructuredMessage`, and `ensureLiveQuery`** in `electron/services/sessions/lifecycle.ts`

At the top of each of these three functions, after the handle lookup, add:

```typescript
if (!handle.inputChannel || !handle.query) return; // TUI mode — input goes through the PTY
```

Same for `stop()` — wrap the SDK cleanup in a `handle.query != null` guard:

```typescript
async function stop(tabId: string): Promise<void> {
  const handle = sessions.get(tabId);
  if (!handle) return;
  handle.tuiJsonl?.stop();
  handle.tuiDetach?.();
  if (handle.inputChannel) handle.inputChannel.close();
  if (handle.query) {
    try { handle.query.close(); } catch { /* ignore */ }
  }
  sessions.delete(tabId);
  ownership?.unregister(tabId);
  queryPassthroughs.evictPluginCache(tabId);
}
```

Adapt the existing `stop()` body to the same shape. Add the `handle.tuiJsonl?.stop();` line wherever the handle is currently cleaned up (search for `existing.inputChannel.close()` in `start()` — same treatment).

- [ ] **Step 4: Patch the `runtime.ts` cleanup paths** to clear `handle.tuiJsonl`:

In each cleanup branch in `listenToMessages` (TUI handoff branch at line 186, identity-replace at 194, error block at 198+, normal close at 226 and 236), add `handle.tuiJsonl?.stop(); handle.tuiJsonl = null;` — but only in the SDK path, since SDK mode shouldn't have one. Cleaner: leave runtime.ts untouched and handle the TUI listener lifecycle entirely in lifecycle.ts (`start`, `stop`, `setMode`). Pick the latter to keep runtime SDK-only.

- [ ] **Step 5: Branch `start()` on mode** in `electron/services/sessions/lifecycle.ts`

Add this near the top of `start()`, before the existing SDK initialization:

```typescript
if (params.mode === 'tui') {
  startTuiColdStart(params);
  return;
}
```

Then add the new function inside `createSessionsService`:

```typescript
async function startTuiColdStart(params: SessionStartParams): Promise<void> {
  const { tabId, projectPath, configDir } = params;
  if (!configDir) throw new Error(`configDir is required to start session for tab ${tabId}`);

  // Close any existing session for this tab
  const existing = sessions.get(tabId);
  if (existing) {
    existing.tuiJsonl?.stop();
    existing.tuiDetach?.();
    if (existing.inputChannel) existing.inputChannel.close();
    if (existing.query) { try { existing.query.close(); } catch { /* ignore */ } }
    sessions.delete(tabId);
    ownership?.unregister(tabId);
    queryPassthroughs.evictPluginCache(tabId);
  }

  const binaryPath = findSystemClaudeBinary();
  if (!binaryPath) throw new Error('startTuiColdStart: claude binary not found');

  const handle: SessionHandle = {
    query: null,
    inputChannel: null,
    sessionId: null,
    status: 'starting',
    mode: 'tui',
    tui: null,
    tuiDetach: null,
    tuiJsonl: null,
    permissionResolver: null,
    permissionQueue: [],
    elicitationResolver: null,
    projectPath,
    configDir,
    sdkOptions: {},
  };
  sessions.set(tabId, handle);
  if (params.ownerWebContentsId !== undefined) {
    ownership?.register(tabId, params.ownerWebContentsId);
  }

  // Snapshot existing JSONLs, spawn the PTY, then poll for the new file.
  const discoveryP = discoverNewSessionFile({ configDir, projectPath });

  const tui = createTuiSession({
    tabId,
    projectPath,
    configDir,
    sessionId: '', // cold-start: no --resume, sessionId discovered post-spawn
    claudeBinaryPath: binaryPath,
  });
  // Hack: createTuiSession currently always adds `--resume <id>`. The cold-
  // start case needs `claude` with no args. See implementation note in this
  // task's Step 6.

  tui.onData((data: string) => sendToRenderer(`session-tui-data:${tabId}`, data));
  tui.onExit((r: { exitCode: number }) => {
    sendToRenderer(`session-tui-exit:${tabId}`, r);
    handle.tuiJsonl?.stop();
    handle.tuiJsonl = null;
    handle.status = 'stopped';
    sendToRenderer(`claude-complete:${tabId}`);
    sessions.delete(tabId);
    ownership?.unregister(tabId);
  });

  handle.tui = tui;
  handle.tuiDetach = () => { try { tui.kill(); } catch { /* ignore */ } };
  sendToRenderer(`session-mode:${tabId}`, { mode: 'tui' });

  try {
    const { sessionId, jsonlPath } = await discoveryP;
    handle.sessionId = sessionId;
    handle.status = 'idle';

    handle.tuiJsonl = createTuiJsonlListener({
      tabId,
      projectPath,
      jsonlPath,
      sendToRenderer,
      notificationHooks,
      onInit: () => {
        // sessionId already known from discovery; ignore subsequent inits.
      },
    });
  } catch (err) {
    console.error('[sessions] TUI cold-start discovery failed:', err);
    sendToRenderer(`claude-error:${tabId}`, err instanceof Error ? err.message : String(err));
    handle.status = 'error';
  }
}
```

Add the imports at the top:

```typescript
import { discoverNewSessionFile } from './tui-coldstart';
import { createTuiJsonlListener } from './tui-jsonl';
```

- [ ] **Step 6: Make `createTuiSession` accept an empty sessionId** in `electron/services/sessions/tui.ts`

Change the `spawn` args:

```typescript
const args = params.sessionId ? ['--resume', params.sessionId] : [];
const pty: IPty = ptySpawn(params.claudeBinaryPath, args, { /* unchanged */ });
```

Update the existing test in `electron/__tests__/tui.test.ts` to keep the `--resume` assertion valid (it still passes a sessionId in those tests).

- [ ] **Step 7: Add a TUI cold-start test** to `electron/__tests__/sessions-tui-coldstart.test.ts`

```typescript
import { spawn as ptySpawn } from 'node-pty';
import { createSessionsService } from '../services/sessions';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../services/sessions/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessions/factory')>();
  return { ...actual, findSystemClaudeBinary: () => '/usr/local/bin/claude' };
});

// ... at the bottom of the existing file:

describe('start({ mode: "tui" })', () => {
  it('spawns claude with no --resume and resolves sessionId from the new JSONL file', async () => {
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-startcold-'));
    const projectPath = '/Users/test/proj';
    const encoded = '-Users-test-proj';
    fs.mkdirSync(path.join(tmpConfig, 'projects', encoded), { recursive: true });

    // Fake pty
    const fakePty = {
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
    };
    vi.mocked(ptySpawn).mockReturnValue(fakePty as any);

    const sendToRenderer = vi.fn();
    const sessions = createSessionsService(sendToRenderer);

    sessions.start({
      tabId: 'cold-1',
      projectPath,
      configDir: tmpConfig,
      model: '',
      permissionMode: '',
      mode: 'tui',
    });

    // Simulate the CLI creating the JSONL after spawn
    setTimeout(() => {
      fs.writeFileSync(path.join(tmpConfig, 'projects', encoded, 'sid-new.jsonl'),
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' }) + '\n');
    }, 50);

    // Wait until sendToRenderer sees session-mode tui AND the listener resolves
    await waitUntil(() => sessions.getSessionId('cold-1') === 'sid-new');
    expect(vi.mocked(ptySpawn).mock.calls[0][1]).toEqual([]); // no --resume

    fs.rmSync(tmpConfig, { recursive: true, force: true });
  });
});
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npm test -- electron/__tests__/sessions-tui-coldstart.test.ts electron/__tests__/tui.test.ts`
Expected: PASS for all.

Then run the full suite to confirm no regressions:

Run: `npm test`
Expected: PASS. The handle nullability change may surface latent assumptions in other tests — chase down any failures and add the `if (handle.query)` guard.

- [ ] **Step 9: Commit checkpoint**

```bash
git add electron/services/sessions/lifecycle.ts electron/services/sessions/types.ts electron/services/sessions/queries.ts electron/services/sessions/runtime.ts electron/services/sessions/tui.ts electron/__tests__/sessions-tui-coldstart.test.ts electron/__tests__/tui.test.ts
git commit -m "feat(sessions): cold-start path for TUI-mode sessions"
```

---

## Task 6: Plumb `mode` through the IPC surface

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/lib/api.ts`

The `session_start` invoke channel already exists. We extend its payload to carry `mode`.

- [ ] **Step 1: Find the `session_start` handler adapter** in `electron/ipc/handlers.ts` (search for `session_start`) and extend it to pass `mode` from the payload:

```typescript
// Inside the session_start handler:
sessionsService.start({
  tabId: data.tabId,
  projectPath: data.projectPath,
  configDir: data.configDir ?? data.config_dir,
  model: data.model,
  permissionMode: data.permissionMode ?? data.permission_mode,
  resumeSessionId: data.resumeSessionId ?? data.resume_session_id,
  effort: data.effort,
  thinking: data.thinking,
  ownerWebContentsId: event.sender.id,
  mode: data.mode, // ← new
});
```

If the handler uses a typed `data` argument, extend that type with `mode?: 'sdk' | 'tui'`.

- [ ] **Step 2: Extend the typed API wrapper** in `src/lib/api.ts` at the `startSession` function:

```typescript
async startSession(
  tabId: string,
  projectPath: string,
  model: string,
  permissionMode: string,
  resumeSessionId?: string,
  configDir?: string,
  effort?: string,
  thinking?: Record<string, unknown>,
  mode?: 'sdk' | 'tui',
): Promise<void> {
  return apiCall("session_start", {
    tabId, projectPath, model, permissionMode, resumeSessionId,
    configDir, effort, thinking, mode,
  });
},
```

- [ ] **Step 3: Run the type check**

Run: `npm run check`
Expected: PASS. If a caller of `startSession` fails because of the new positional param, leave it — they're not affected (it's optional).

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit checkpoint**

```bash
git add electron/main.ts electron/ipc/handlers.ts src/lib/api.ts
git commit -m "feat(sessions): plumb mode parameter through session_start IPC"
```

---

## Task 7: `MessagePanel` renderer component

**Files:**
- Create: `src/components/MessagePanel.tsx`
- Create: `src/components/__tests__/MessagePanel.test.tsx` (or skip — pure-visual; smoke-test instead)

The panel subscribes to `session-jsonl:<tabId>`, maintains a flat list of message objects, and renders each as a card. Phase 1 supports four shapes: user message, assistant message, tool_use, tool_result. Everything else renders as a small "system" pill (or is ignored — TBD).

- [ ] **Step 1: Create the component** in `src/components/MessagePanel.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface MessagePanelProps {
  tabId: string;
}

interface JsonlRecord {
  type?: string;
  subtype?: string;
  message?: { role?: string; content?: unknown };
  session_id?: string;
  // Tool-use / tool-result fields vary; we read them defensively in render.
  [key: string]: unknown;
}

export function MessagePanel({ tabId }: MessagePanelProps) {
  const [records, setRecords] = useState<JsonlRecord[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `session-jsonl:${tabId}`,
      (...args: unknown[]) => {
        const rec = args[0] as JsonlRecord | undefined;
        if (!rec || typeof rec !== 'object') return;
        setRecords((prev) => [...prev, rec]);
      },
    );
    return unlisten;
  }, [tabId]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [records]);

  return (
    <div ref={scrollerRef} className="h-full w-full overflow-y-auto p-3 space-y-2 bg-background">
      {records.map((r, i) => (
        <MessageCard key={i} record={r} />
      ))}
    </div>
  );
}

function MessageCard({ record }: { record: JsonlRecord }) {
  // user message
  if (record.type === 'user') {
    const content = extractText(record.message?.content);
    return (
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="text-xs uppercase tracking-wide text-blue-500/80 mb-1">user</div>
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }
  // assistant message
  if (record.type === 'assistant') {
    const content = extractText(record.message?.content);
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="text-xs uppercase tracking-wide text-emerald-500/80 mb-1">assistant</div>
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }
  // tool_use / tool_result are nested in assistant messages' content arrays;
  // we'll surface them in Phase 2. For Phase 1, top-level `type: 'result'`
  // and `type: 'system'` get a thin pill.
  if (record.type === 'result') {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
        result · {record.subtype as string ?? 'success'}
      </div>
    );
  }
  if (record.type === 'system') {
    return (
      <div className="rounded-md border border-muted bg-muted/30 p-2 text-xs text-muted-foreground">
        system · {record.subtype as string ?? 'event'}
      </div>
    );
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}
```

(Reuse the project's existing markdown component if `ReactMarkdown` isn't already in the renderer — search `src/components` for an existing `Markdown` or similar wrapper before adding the bare import.)

- [ ] **Step 2: Smoke-render check**

Run: `npm run check`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

No unit test for the component in this task — it's purely visual; we'll iterate on it once we see it.

- [ ] **Step 3: Commit checkpoint**

```bash
git add src/components/MessagePanel.tsx
git commit -m "feat(renderer): MessagePanel for TUI-mode session view"
```

---

## Task 8: `TuiSessionLayout` 50/50 split + wire into `ClaudeCodeSession`

**Files:**
- Create: `src/components/TuiSessionLayout.tsx`
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Create the layout** in `src/components/TuiSessionLayout.tsx`:

```tsx
import { TerminalView } from './TerminalView';
import { MessagePanel } from './MessagePanel';

interface TuiSessionLayoutProps {
  tabId: string;
}

export function TuiSessionLayout({ tabId }: TuiSessionLayoutProps) {
  return (
    <div className="flex h-full w-full">
      <div className="w-1/2 h-full border-r border-border">
        <TerminalView tabId={tabId} />
      </div>
      <div className="w-1/2 h-full">
        <MessagePanel tabId={tabId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add mode-state in `ClaudeCodeSession.tsx`**

Find the top-level render in `src/components/ClaudeCodeSession.tsx`. Add a `sessionMode` state and subscribe to `session-mode:<tabId>`:

```typescript
const [sessionMode, setSessionMode] = useState<'sdk' | 'tui'>('sdk');

useEffect(() => {
  if (!tabId) return;
  const unlisten = window.electronAPI.onEvent(
    `session-mode:${tabId}`,
    (...args: unknown[]) => {
      const payload = args[0] as { mode?: 'sdk' | 'tui' } | undefined;
      if (payload?.mode === 'sdk' || payload?.mode === 'tui') {
        setSessionMode(payload.mode);
      }
    },
  );
  return unlisten;
}, [tabId]);
```

Then wrap the existing return value with the mode branch. Near the JSX return:

```tsx
if (sessionMode === 'tui') {
  return <TuiSessionLayout tabId={tabId} />;
}
// ... existing SDK-mode render unchanged
```

Add `import { TuiSessionLayout } from './TuiSessionLayout';` near the top.

- [ ] **Step 3: Run the type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke (launch the app)**

Run: `npm start`
Steps:
1. Open OmniFex
2. Open an existing project that already has a session
3. Start a session in SDK mode (default)
4. Use the existing mode-switch UI to toggle into TUI mode
5. Confirm the 50/50 layout renders: xterm.js on the left, empty `MessagePanel` on the right
6. Type into the terminal; confirm any messages flushed to JSONL appear as cards in the panel
7. Send a prompt, wait for `result`; confirm OS notification fires

If any step fails: note it, debug, and revisit. Don't move on with a broken layout.

- [ ] **Step 5: Commit checkpoint**

```bash
git add src/components/TuiSessionLayout.tsx src/components/ClaudeCodeSession.tsx
git commit -m "feat(renderer): 50/50 TuiSessionLayout for TUI-mode sessions"
```

---

## Task 9: Theme `TerminalView` + clickable URLs

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `package.json` (add `@xterm/addon-web-links`)

- [ ] **Step 1: Install the addon**

Run: `npm install @xterm/addon-web-links`
Expected: dependency added to `package.json`, no errors.

- [ ] **Step 2: Update `TerminalView.tsx`** to load the addon and use OmniFex colors:

```typescript
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface TerminalViewProps {
  tabId: string;
}

export function TerminalView({ tabId }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    // Read OmniFex theme tokens from CSS custom properties so the terminal
    // matches the rest of the app under both light and dark modes. Falls
    // back to a sensible default if a variable isn't set.
    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    const term = new Terminal({
      fontFamily: cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'),
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
      theme: {
        background: '#00000000',
        foreground: cssVar('--foreground-rgb', '#e6e6e6'),
        cursor: cssVar('--foreground-rgb', '#e6e6e6'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void window.electronAPI.openExternal?.(uri);
    }));
    term.open(hostRef.current);
    fit.fit();

    api.tuiResize(tabId, term.cols, term.rows).catch(console.error);

    const dataDisposable = term.onData((data) => {
      api.tuiWrite(tabId, data).catch(console.error);
    });

    const unlistenData = window.electronAPI.onEvent(
      `session-tui-data:${tabId}`,
      (...args: unknown[]) => {
        const data = args[0];
        if (typeof data === 'string') term.write(data);
      },
    );

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        api.tuiResize(tabId, term.cols, term.rows).catch(console.error);
      } catch {
        // ResizeObserver can fire after disposal; ignore.
      }
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      unlistenData();
      term.dispose();
    };
  }, [tabId]);

  return <div ref={hostRef} className="h-full w-full" />;
}
```

The CSS variable names (`--font-mono`, `--foreground-rgb`) are placeholders — substitute whatever the OmniFex theme actually exposes. If those vars don't exist, check `src/styles` or `src/index.css` for the project's actual token names and adapt.

- [ ] **Step 3: Run the type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run: `npm start`
1. Open a TUI session
2. Confirm the terminal uses the OmniFex monospace font and the background blends with the panel
3. Have Claude print a URL (or type one in); confirm clicking it opens externally rather than dropping a "cmd-click only" hint

- [ ] **Step 5: Commit checkpoint**

```bash
git add package.json package-lock.json src/components/TerminalView.tsx
git commit -m "feat(renderer): theme TerminalView + clickable URLs"
```

---

## Task 10: "Start in Terminal mode" entry point

**Files:**
- Modify: `src/components/NewSessionForm.tsx` (or wherever new sessions are kicked off — search for `api.startSession` callers)

Add a "Start in Terminal mode" toggle/button to the new-session flow. The wiring is one extra positional arg in the `api.startSession` call.

- [ ] **Step 1: Find the session-start call site**

Run: `grep -rn "api.startSession\|startSession(" src/`

The most likely location is `src/components/NewSessionForm.tsx` or `src/App.tsx`. Identify the primary caller — that's where the toggle lives.

- [ ] **Step 2: Add a mode toggle near the existing start button**

Add a checkbox or two-position toggle to the form:

```tsx
const [startInTerminal, setStartInTerminal] = useState(false);

// In the JSX:
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={startInTerminal}
    onChange={(e) => setStartInTerminal(e.target.checked)}
  />
  Start in Terminal mode (uses local Claude CLI, no SDK budget)
</label>
```

Then thread the value into the start call:

```typescript
await api.startSession(
  tabId,
  projectPath,
  model,
  permissionMode,
  resumeSessionId,
  configDir,
  effort,
  thinking,
  startInTerminal ? 'tui' : 'sdk',
);
```

- [ ] **Step 3: Run the type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

Run: `npm start`
1. Open the new-session form
2. Toggle "Start in Terminal mode" and start
3. Confirm the layout opens directly into the 50/50 view, the PTY is spawned, and a sessionId appears
4. Type a prompt in the terminal, hit Enter, wait for the assistant to reply
5. Confirm:
   - Reply appears in the right-hand panel
   - OS notification fires on turn completion
   - Tab badge increments

- [ ] **Step 5: Commit checkpoint**

```bash
git add src/components/NewSessionForm.tsx
git commit -m "feat(renderer): start-in-terminal toggle in new-session form"
```

---

## Final verification

- [ ] **Run the full verification gate** per `CLAUDE.md`:

```bash
npm run check
npm run test:coverage
npm run build
```

Expected:
- `check`: PASS
- `test:coverage`: PASS, ≥80% line coverage on backend `electron/services/sessions/*` files touched
- `build`: PASS

- [ ] **Rebuild native modules for Electron** (per the auto-memory `[[project_native_module_abi]]` and `[[feedback_electron_rebuild_after_tests]]`):

```bash
npm run rebuild:electron
```

This is critical — vitest rebuilt `node-pty` and `better-sqlite3` for the Node ABI, and Greg's next `npm start` needs them rebuilt for the Electron ABI.

- [ ] **Manual end-to-end pass**

Run: `npm start`
1. SDK-mode session: unchanged behavior (default), verify a prompt and reply work as before
2. TUI cold-start: new session with the toggle on; confirm 50/50 layout, terminal driving, panel populating, notification firing
3. Mode toggle on an SDK session: switch to TUI mid-session; confirm the layout flips and the panel keeps populating from the resumed JSONL
4. Switch back from TUI to SDK on the same session; confirm the original UI re-renders cleanly

- [ ] **Update memory** if anything surprised you (per repo conventions, write a new memory file under `~/.claude-personal/projects/-Users-gregorychristie-Repos-personal-omnifex/memory/` and add a one-line index entry to `MEMORY.md`).

---

## Self-Review (writing-plans skill)

**Spec coverage:**
- Cold-start in TUI mode → Task 5
- 50/50 layout with TerminalView + MessagePanel → Tasks 7, 8
- JSONL drives notifications → Tasks 2, 3
- JSONL drives panel → Task 7 + event channel from Task 3
- Theme + clickable links → Task 9
- Manual mode toggle preserved → no change needed (already exists in `lifecycle.ts`)
- Tests for backend changes → Tasks 1, 2, 3, 4, 5
- Spec's three deferred mechanics questions:
  - history-on-resume in panel: deferred (Phase 2)
  - notification helper home: resolved to `notifications.ts` (Task 2)
  - `start()` mode param vs sibling `startTui()`: resolved to `start({ mode })` (Task 5)

**Placeholder scan:** No "TBD" / "TODO" / "implement later" outside the explicit Phase-1 non-goals and the Phase-2 history-on-resume note in Task 7's comment.

**Type consistency:** `SessionHandle.query` and `SessionHandle.inputChannel` are nullable across Tasks 5 and 6 in all touched files. `mode` is `'sdk' | 'tui'` everywhere. `dispatchResultNotification` signature in Task 2 matches its use in Tasks 2 (runtime.ts) and 3 (tui-jsonl.ts).
