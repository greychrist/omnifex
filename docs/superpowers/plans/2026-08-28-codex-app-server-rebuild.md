# Codex `app-server` Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex sessions work again by rebuilding the engine on `codex app-server`, and scope Codex sessions to their account via `CODEX_HOME`.

**Architecture:** Keep the `AgentEngine` seam exactly as it is — it held up. Replace the wire layer underneath it (`codex-cli-engine.ts`, `json-rpc-client.ts`) and the fold above it (a new pure reducer feeding `CodexTranscript`). Protocol types are hand-written and narrow; drift is caught by a version floor, not by generated code.

**Tech Stack:** TypeScript, Electron main process, `node:child_process`, newline-delimited JSON-RPC, Vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-08-28-codex-app-server-rebuild-design.md`

## Global Constraints

- Target `codex-cli` **0.135.0**. `SUPPORTED_CODEX_VERSION = '0.135.0'` is the floor; below it, fail the session start with a specific message.
- Transport is `codex app-server` over stdio. Never `codex mcp` (removed) and never `codex mcp-server` (wrong granularity).
- The spawn env **deletes `CLAUDE_CONFIG_DIR`** and **sets `CODEX_HOME` to `AgentStartParams.configDir`**.
- Handshake order is fixed and load-bearing: `initialize` (request) → `initialized` (notification, **no id**) → `thread/start` or `thread/resume`.
- Codex is rich-mode only. Do not add Codex to `startTuiColdStart`.
- `AccountsService.resolve()` step 3 (on-disk ownership) stays Claude-only. Do not add a Codex default-account fallback.
- TDD is mandatory (repo CLAUDE.md). Failing test first, every task.
- No worktrees for this repo. Work on a branch in the main checkout: `git checkout -b feat/codex-app-server`.
- Verification gate per task: `npm run check` plus the task's own tests. Full gate before merge: `npm run check && npm test && npm run build`.
- After any vitest run, `npm run rebuild:electron` before Greg restarts the app (native ABI).

---

### Task 1: `json-rpc-client` can send notifications

The handshake needs `initialized`, which is a JSON-RPC *notification* — no `id`, no reply. `request()` always allocates an id, so sending `initialized` through it leaves a promise pending forever.

**Files:**
- Modify: `electron/services/agents/json-rpc-client.ts`
- Test: `electron/__tests__/agents/json-rpc-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JsonRpcClient.notify(method: string, params?: unknown): void`

- [ ] **Step 1: Write the failing test**

```ts
it('notify() writes a frame with no id and never allocates a pending entry', () => {
  const writes: string[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { writes.push(chunk.toString('utf8')); cb(); },
  });
  const client = createJsonRpcClient({
    readable: new Readable({ read() {} }),
    writable,
  });

  client.notify('initialized');

  expect(JSON.parse(writes[0])).toEqual({ jsonrpc: '2.0', method: 'initialized' });
  expect(Object.prototype.hasOwnProperty.call(JSON.parse(writes[0]), 'id')).toBe(false);
});

it('notify() includes params when given', () => {
  const writes: string[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { writes.push(chunk.toString('utf8')); cb(); },
  });
  const client = createJsonRpcClient({
    readable: new Readable({ read() {} }),
    writable,
  });

  client.notify('some/event', { a: 1 });

  expect(JSON.parse(writes[0])).toEqual({
    jsonrpc: '2.0', method: 'some/event', params: { a: 1 },
  });
});

it('notify() is a no-op after close()', () => {
  const writes: string[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { writes.push(chunk.toString('utf8')); cb(); },
  });
  const client = createJsonRpcClient({
    readable: new Readable({ read() {} }),
    writable,
  });

  client.close();
  client.notify('initialized');

  expect(writes).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/agents/json-rpc-client.test.ts`
Expected: FAIL — `client.notify is not a function`

- [ ] **Step 3: Write minimal implementation**

In `json-rpc-client.ts`, add to the interface:

```ts
export interface JsonRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /**
   * Fire-and-forget JSON-RPC notification — no `id`, no response. The
   * app-server handshake requires `initialized` to be sent this way;
   * routing it through request() would leave a promise pending forever
   * because notifications are never answered.
   */
  notify(method: string, params?: unknown): void;
  respondToServer(
    id: string | number,
    payload: { result: unknown } | { error: { code: number; message: string } },
  ): void;
  close(): void;
}
```

and the implementation, next to `request`:

```ts
  function notify(method: string, params?: unknown): void {
    if (closed) return;
    writeFrame(
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params },
    );
  }
```

Return it: `return { request, notify, respondToServer, close };`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agents/json-rpc-client.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/agents/json-rpc-client.ts electron/__tests__/agents/json-rpc-client.test.ts
git commit -m "feat(codex): add notify() to the JSON-RPC client for app-server's initialized handshake"
```

---

### Task 2: Narrow app-server protocol types

**Files:**
- Create: `electron/services/agents/codex-protocol.ts`
- Test: none (types only — it is exercised by every later task and `npm run check` is the gate)

**Interfaces:**
- Consumes: nothing.
- Produces: everything below, imported by Tasks 3–7.

- [ ] **Step 1: Write the file**

```ts
/**
 * Narrow hand-written subset of the `codex app-server` protocol.
 *
 * The full protocol is ~85 client methods and ~65 server notifications.
 * We consume roughly ten of each, so vendoring the generated bindings
 * would be 80 files of surface we never call — which rots exactly as
 * silently as this does while being far harder to review.
 *
 * To regenerate the authoritative bindings when auditing a Codex upgrade:
 *
 *     codex app-server generate-ts --out /tmp/codex-proto
 *
 * Verified against codex-cli 0.135.0 on 2026-08-28. See
 * docs/superpowers/specs/2026-08-28-codex-app-server-rebuild-design.md §4.
 */

export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReviewDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

/** `initialize` result. `codexHome` echoes the CODEX_HOME we spawned with. */
export interface CodexInitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  cwd: string;
  /** Rollout JSONL path — the same file codex-session-walker discovers. */
  path: string | null;
  cliVersion: string;
  status: { type: string };
}

export interface CodexThreadStartResult {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: CodexApprovalPolicy;
  reasoningEffort: string | null;
}

/** `turn/start` / `turn/steer` input element. */
export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string };

export interface CodexTurn {
  id: string;
  status: { type: string } | string;
}

/**
 * `ThreadItem` — the tagged union every transcript card is built from.
 * Only the variants we render are spelled out; the rest fall through to
 * `CodexItemFallback` and are typed loosely on purpose.
 */
export type CodexThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: Array<{ path?: string; [k: string]: unknown }>;
      status: string;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      durationMs: number | null;
    }
  | { type: 'webSearch'; id: string; query: string }
  | { type: string; id: string; [k: string]: unknown };

export interface CodexItemNotificationParams {
  item: CodexThreadItem;
  threadId: string;
  turnId: string;
}

export interface CodexTokenUsage {
  threadId: string;
  [k: string]: unknown;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

export interface CodexModelListResult {
  data: CodexModel[];
  nextCursor: string | null;
}

/** Thrown when a cross-agent control subtype has no Codex equivalent. */
export class CodexUnsupportedControl extends Error {
  readonly subtype: string;
  constructor(subtype: string) {
    super(`Codex does not support the '${subtype}' control request`);
    this.name = 'CodexUnsupportedControl';
    this.subtype = subtype;
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add electron/services/agents/codex-protocol.ts
git commit -m "feat(codex): add narrow app-server protocol types"
```

---

### Task 3: Permission-mode mapping (pure)

Split out first because it is pure, it is the piece most likely to be argued with, and both `start()` and `applyExtendedPermissionMode()` need it.

**Files:**
- Create: `electron/services/agents/codex-permission-mode.ts`
- Test: `electron/__tests__/agents/codex-permission-mode.test.ts`

**Interfaces:**
- Consumes: `CodexApprovalPolicy`, `CodexSandboxMode` from Task 2.
- Produces: `mapPermissionMode(mode: string | undefined): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mapPermissionMode } from '../../services/agents/codex-permission-mode';

describe('mapPermissionMode', () => {
  it.each([
    ['default',           'on-request', 'workspace-write'],
    ['plan',              'untrusted',  'read-only'],
    ['acceptEdits',       'on-failure', 'workspace-write'],
    ['auto',              'never',      'workspace-write'],
    ['dontAsk',           'never',      'workspace-write'],
    ['bypassPermissions', 'never',      'danger-full-access'],
  ])('maps %s to %s / %s', (mode, approvalPolicy, sandbox) => {
    expect(mapPermissionMode(mode)).toEqual({ approvalPolicy, sandbox });
  });

  it('falls back to default for undefined', () => {
    expect(mapPermissionMode(undefined)).toEqual({
      approvalPolicy: 'on-request', sandbox: 'workspace-write',
    });
  });

  it('falls back to default for an unknown mode rather than throwing', () => {
    expect(mapPermissionMode('someFutureMode')).toEqual({
      approvalPolicy: 'on-request', sandbox: 'workspace-write',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/agents/codex-permission-mode.test.ts`
Expected: FAIL — cannot resolve `codex-permission-mode`

- [ ] **Step 3: Write minimal implementation**

```ts
import type { CodexApprovalPolicy, CodexSandboxMode } from './codex-protocol';

export interface CodexPermissionSettings {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
}

const DEFAULT: CodexPermissionSettings = {
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
};

/**
 * OmniFex's permission modes are Claude-shaped: one axis. Codex splits the
 * same concern across `approvalPolicy` and `sandbox`. This mapping is an
 * approximation, deliberately — there is no exact correspondence, and the
 * spec (§5.5) records the reasoning. An unknown mode degrades to the
 * default rather than throwing: a future Claude-side mode must not be able
 * to kill a Codex session start.
 */
const TABLE: Record<string, CodexPermissionSettings> = {
  default: DEFAULT,
  plan: { approvalPolicy: 'untrusted', sandbox: 'read-only' },
  acceptEdits: { approvalPolicy: 'on-failure', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  dontAsk: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

export function mapPermissionMode(mode: string | undefined): CodexPermissionSettings {
  if (mode === undefined) return DEFAULT;
  return TABLE[mode] ?? DEFAULT;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agents/codex-permission-mode.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/agents/codex-permission-mode.ts electron/__tests__/agents/codex-permission-mode.test.ts
git commit -m "feat(codex): map OmniFex permission modes onto Codex approvalPolicy + sandbox"
```

---

### Task 4: Engine — spawn, `CODEX_HOME`, and the three-step handshake

This is the task that makes Codex sessions start at all.

**Files:**
- Modify: `electron/services/agents/codex-cli-engine.ts` (rewrite `start()` and the spawn env)
- Test: `electron/__tests__/agents/codex-cli-engine.test.ts` (rewrite the `start()` describes)

**Interfaces:**
- Consumes: `notify()` (Task 1), `CodexThreadStartResult` / `CodexInitializeResult` (Task 2), `mapPermissionMode` (Task 3).
- Produces: an engine whose `getResumeId()` returns the app-server `threadId`.

- [ ] **Step 1: Write the failing test**

Replace the `start() cold-start handshake` describe block. Reuse the existing `makeFakeChild` / `flushMicrotasks` helpers already at the top of the file — do not rewrite them.

```ts
/** Read the JSON frames the engine has written to the fake child's stdin. */
function writtenFrames(fake: FakeChild): Array<Record<string, unknown>> {
  return fake.stdin._writes
    .join('')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Push a JSON-RPC frame from the fake server to the engine. */
function serverSend(fake: FakeChild, frame: unknown): void {
  fake.stdout.push(JSON.stringify(frame) + '\n');
}

describe('start() cold-start handshake', () => {
  it('spawns `codex app-server` with CODEX_HOME set and CLAUDE_CONFIG_DIR stripped', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    process.env.CLAUDE_CONFIG_DIR = '/Users/x/.claude-work';

    const engine = createCodexCliEngine({
      tabId: 'tab-x', codexBinaryPath: '/usr/local/bin/codex',
    });
    const started = engine.start({
      projectPath: '/p', configDir: '/Users/x/.codex-personal',
      sessionId: 's-1', resume: false,
    });
    started.catch(() => { /* driven below */ });
    await flushMicrotasks();

    expect(mockedSpawn).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: '/p',
        env: expect.objectContaining({ CODEX_HOME: '/Users/x/.codex-personal' }),
      }),
    );
    const env = mockedSpawn.mock.calls[0][2]!.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();

    engine.kill();
  });

  it('sends initialize, then the initialized notification, then thread/start — in that order', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const engine = createCodexCliEngine({
      tabId: 'tab-x', codexBinaryPath: '/usr/local/bin/codex',
    });
    const started = engine.start({
      projectPath: '/p', configDir: '/c', model: 'gpt-5.5',
      permissionMode: 'plan', sessionId: 's-1', resume: false,
    });
    started.catch(() => { /* driven below */ });
    await flushMicrotasks();

    const first = writtenFrames(fake);
    expect(first[0]).toMatchObject({ id: 1, method: 'initialize' });
    // The client must not proceed before the server answers initialize.
    expect(first).toHaveLength(1);

    serverSend(fake, { id: 1, result: { codexHome: '/c', userAgent: 'x' } });
    await flushMicrotasks();

    const frames = writtenFrames(fake);
    expect(frames[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' });
    expect(frames[2]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/p',
        model: 'gpt-5.5',
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
      },
    });

    serverSend(fake, {
      id: (frames[2] as { id: number }).id,
      result: { thread: { id: 'thread-abc', cwd: '/p', path: '/r.jsonl' }, model: 'gpt-5.5' },
    });
    await started;

    expect(engine.getResumeId()).toBe('thread-abc');
  });

  it('resume sends thread/resume with the caller session id as threadId', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const engine = createCodexCliEngine({
      tabId: 'tab-x', codexBinaryPath: '/usr/local/bin/codex',
    });
    const started = engine.start({
      projectPath: '/p', configDir: '/c', sessionId: 'thread-old', resume: true,
    });
    started.catch(() => { /* driven below */ });
    await flushMicrotasks();
    serverSend(fake, { id: 1, result: { codexHome: '/c' } });
    await flushMicrotasks();

    const frames = writtenFrames(fake);
    expect(frames[2]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-old', cwd: '/p' },
    });

    serverSend(fake, {
      id: (frames[2] as { id: number }).id,
      result: { thread: { id: 'thread-old', cwd: '/p', path: '/r.jsonl' } },
    });
    await started;
    expect(engine.getResumeId()).toBe('thread-old');
  });

  it('tears down the child when the handshake rejects', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);

    const engine = createCodexCliEngine({
      tabId: 'tab-x', codexBinaryPath: '/usr/local/bin/codex',
    });
    const started = engine.start({
      projectPath: '/p', configDir: '/c', sessionId: 's-1', resume: false,
    });
    await flushMicrotasks();
    serverSend(fake, { id: 1, error: { code: -32600, message: 'nope' } });

    await expect(started).rejects.toThrow('nope');
    expect(fake.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/agents/codex-cli-engine.test.ts -t 'cold-start handshake'`
Expected: FAIL — engine still spawns `['mcp']` and sends `newConversation`

- [ ] **Step 3: Write the implementation**

In `codex-cli-engine.ts`, replace the spawn + handshake block inside `start()`. Everything above it (killing a prior child, resetting `stderrBuf`) stays.

```ts
    // Codex reads its state from CODEX_HOME. Setting it from the resolved
    // account's config dir is what makes Codex sessions account-scoped —
    // codex-auth.ts has always written auth.json per account, but the
    // engine used to ignore configDir entirely and every session ran
    // against ~/.codex. CLAUDE_CONFIG_DIR is stripped so Claude account
    // state can't leak into Codex's environment.
    const env = { ...process.env, CODEX_HOME: p.configDir };
    delete env.CLAUDE_CONFIG_DIR;

    child = spawn(factory.codexBinaryPath, ['app-server'], {
      cwd: p.projectPath,
      env,
    }) as ChildProcessWithoutNullStreams;
```

Then replace the handshake body:

```ts
    try {
      rpc = createJsonRpcClient({
        readable: child.stdout,
        writable: child.stdin,
        onNotification,
        onServerRequest: handleServerRequest,
      });

      // Three-step handshake, order load-bearing: app-server ignores
      // thread/* until `initialized` has arrived, and `initialized` is a
      // notification — sending it as a request would hang forever.
      await rpc.request<CodexInitializeResult>('initialize', {
        clientInfo: { name: 'omnifex', title: 'OmniFex', version: app.getVersion() },
        capabilities: null,
      });
      rpc.notify('initialized');

      permissionSettings = mapPermissionMode(p.permissionMode);

      const common = {
        cwd: p.projectPath,
        approvalPolicy: permissionSettings.approvalPolicy,
        sandbox: permissionSettings.sandbox,
        ...(p.model ? { model: p.model } : {}),
        ...(p.codex ?? {}),
      };

      const result = p.resume
        ? await rpc.request<CodexThreadStartResult>('thread/resume', {
            threadId: p.sessionId,
            ...common,
          })
        : await rpc.request<CodexThreadStartResult>('thread/start', common);

      threadId = result?.thread?.id ?? (p.resume ? p.sessionId : null);
    } catch (err) {
      await close();
      throw err;
    }
```

Rename the module-level `conversationId` to `threadId` throughout (including `getResumeId`), add `let permissionSettings = mapPermissionMode(undefined);`, and add the imports:

```ts
import { app } from 'electron';
import { mapPermissionMode, type CodexPermissionSettings } from './codex-permission-mode';
import type { CodexInitializeResult, CodexThreadStartResult } from './codex-protocol';
```

Update the file's top docblock: it still claims `codex mcp` and "v1 does NOT set CODEX_HOME". Both are now false.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agents/codex-cli-engine.test.ts && npm run check`
Expected: PASS. Other describes in the file will fail — they still assert the old protocol. Task 5 rewrites them; if that is disruptive, mark them `describe.skip` **in this commit only** and un-skip in Task 5.

- [ ] **Step 5: Commit**

```bash
git add electron/services/agents/codex-cli-engine.ts electron/__tests__/agents/codex-cli-engine.test.ts
git commit -m "feat(codex): rebuild engine handshake on app-server, scope sessions via CODEX_HOME"
```

---

### Task 5: Engine — turns, interrupt, and the approval id round-trip

**Files:**
- Modify: `electron/services/agents/codex-cli-engine.ts`
- Test: `electron/__tests__/agents/codex-cli-engine.test.ts`

**Interfaces:**
- Consumes: Task 4's engine.
- Produces: working `send`, `sendStructured`, `interrupt`, `respondPermission`.

- [ ] **Step 1: Write the failing test**

```ts
describe('turns and interrupts', () => {
  /** Drive an engine through the handshake and return it, ready for turns. */
  async function startedEngine(): Promise<{ engine: AgentEngine; fake: FakeChild }> {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createCodexCliEngine({
      tabId: 'tab-x', codexBinaryPath: '/usr/local/bin/codex',
    });
    const started = engine.start({
      projectPath: '/p', configDir: '/c', sessionId: 's-1', resume: false,
    });
    await flushMicrotasks();
    serverSend(fake, { id: 1, result: { codexHome: '/c' } });
    await flushMicrotasks();
    const frames = writtenFrames(fake);
    serverSend(fake, {
      id: (frames[2] as { id: number }).id,
      result: { thread: { id: 'thread-abc', cwd: '/p', path: '/r.jsonl' } },
    });
    await started;
    fake.stdin._writes.length = 0;
    return { engine, fake };
  }

  it('send() issues turn/start with a text UserInput carrying text_elements', async () => {
    const { engine, fake } = await startedEngine();
    void engine.send('hello');
    await flushMicrotasks();

    expect(writtenFrames(fake)[0]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-abc',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
    });
    engine.kill();
  });

  it('sendStructured() maps Claude text and image blocks onto UserInput', async () => {
    const { engine, fake } = await startedEngine();
    void engine.sendStructured([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', data: 'AAA', media_type: 'image/png' } },
    ]);
    await flushMicrotasks();

    expect(writtenFrames(fake)[0]).toMatchObject({
      method: 'turn/start',
      params: {
        input: [
          { type: 'text', text: 'look', text_elements: [] },
          { type: 'image', url: 'data:image/png;base64,AAA' },
        ],
      },
    });
    engine.kill();
  });

  it('interrupt() sends the tracked turnId from turn/started', async () => {
    const { engine, fake } = await startedEngine();
    serverSend(fake, {
      method: 'turn/started',
      params: { threadId: 'thread-abc', turn: { id: 'turn-9' } },
    });
    await flushMicrotasks();
    fake.stdin._writes.length = 0;

    void engine.interrupt();
    await flushMicrotasks();

    expect(writtenFrames(fake)[0]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-abc', turnId: 'turn-9' },
    });
    engine.kill();
  });

  it('interrupt() is a no-op when no turn is in flight', async () => {
    const { engine, fake } = await startedEngine();
    serverSend(fake, {
      method: 'turn/started', params: { threadId: 'thread-abc', turn: { id: 'turn-9' } },
    });
    serverSend(fake, {
      method: 'turn/completed', params: { threadId: 'thread-abc', turn: { id: 'turn-9' } },
    });
    await flushMicrotasks();
    fake.stdin._writes.length = 0;

    await engine.interrupt();
    expect(writtenFrames(fake)).toHaveLength(0);
    engine.kill();
  });

  it('respondPermission replies with the ORIGINAL numeric id, not the stringified one', async () => {
    const { engine, fake } = await startedEngine();
    const seen: AgentPermissionRequest[] = [];
    engine.onPermissionRequest((r) => seen.push(r));

    serverSend(fake, {
      id: 77,
      method: 'execCommandApproval',
      params: { command: ['rm', '-rf', '/'], cwd: '/p', callId: 'c1' },
    });
    await flushMicrotasks();
    fake.stdin._writes.length = 0;

    expect(seen[0].requestId).toBe('77');
    await engine.respondPermission(seen[0].requestId, 'allow');

    expect(writtenFrames(fake)[0]).toEqual({
      jsonrpc: '2.0', id: 77, result: { decision: 'approved' },
    });
    engine.kill();
  });

  it('maps a deny decision onto ReviewDecision denied', async () => {
    const { engine, fake } = await startedEngine();
    const seen: AgentPermissionRequest[] = [];
    engine.onPermissionRequest((r) => seen.push(r));
    serverSend(fake, {
      id: 78, method: 'applyPatchApproval', params: { fileChanges: {}, callId: 'c2' },
    });
    await flushMicrotasks();
    fake.stdin._writes.length = 0;

    await engine.respondPermission(seen[0].requestId, 'deny');
    expect(writtenFrames(fake)[0]).toMatchObject({ id: 78, result: { decision: 'denied' } });
    engine.kill();
  });

  it('routes the modern item/*/requestApproval methods too', async () => {
    const { engine, fake } = await startedEngine();
    const seen: AgentPermissionRequest[] = [];
    engine.onPermissionRequest((r) => seen.push(r));

    serverSend(fake, {
      id: 79,
      method: 'item/commandExecution/requestApproval',
      params: { command: ['ls'], cwd: '/p' },
    });
    await flushMicrotasks();

    expect(seen[0].kind).toBe('exec');
    engine.kill();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/agents/codex-cli-engine.test.ts -t 'turns and interrupts'`
Expected: FAIL — `sendStructured: not yet wired`, and interrupt sends `interruptConversation`

- [ ] **Step 3: Write the implementation**

Add turn tracking beside the other module-level state:

```ts
  let currentTurnId: string | null = null;
  /** Stringified server-request id → the original id we must reply with. */
  const pendingApprovals = new Map<string, string | number>();
```

In `onNotification`, track the turn before forwarding:

```ts
  function onNotification(method: string, params: unknown): void {
    // turn/interrupt needs BOTH threadId and turnId, and turnId only ever
    // arrives here — without tracking it, interrupt is impossible.
    if (method === 'turn/started') {
      const p = params as { turn?: { id?: unknown } } | null;
      if (typeof p?.turn?.id === 'string') currentTurnId = p.turn.id;
    } else if (method === 'turn/completed') {
      currentTurnId = null;
    }
    emitMessage({ /* unchanged */ });
  }
```

Rewrite `handleServerRequest` to cover both approval generations and record the id:

```ts
  const EXEC_APPROVAL_METHODS = new Set([
    'execCommandApproval',
    'item/commandExecution/requestApproval',
  ]);
  const PATCH_APPROVAL_METHODS = new Set([
    'applyPatchApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ]);

  function handleServerRequest(method: string, params: unknown, id: string | number): void {
    if (EXEC_APPROVAL_METHODS.has(method) || PATCH_APPROVAL_METHODS.has(method)) {
      pendingApprovals.set(String(id), id);
      const isExec = EXEC_APPROVAL_METHODS.has(method);
      const p = (params ?? {}) as { command?: unknown };
      const cmd = Array.isArray(p.command) ? p.command.join(' ')
        : typeof p.command === 'string' ? p.command
        : '<unknown>';
      emitPermission({
        agent: 'codex',
        requestId: String(id),
        kind: isExec ? 'exec' : 'patch',
        summary: isExec ? `Run: ${cmd}` : 'Apply patch',
        payload: params,
      });
      return;
    }
    if (rpc !== null) {
      rpc.respondToServer(id, {
        error: { code: -32601, message: `Method not handled: ${method}` },
      });
    }
  }
```

Replace `send`, `sendStructured`, `interrupt`, `respondPermission`:

```ts
  function toUserInput(block: unknown): CodexUserInput | null {
    if (typeof block === 'string') {
      return { type: 'text', text: block, text_elements: [] };
    }
    if (!block || typeof block !== 'object') return null;
    const b = block as {
      type?: string; text?: string;
      source?: { data?: string; media_type?: string; url?: string };
    };
    if (b.type === 'text' && typeof b.text === 'string') {
      return { type: 'text', text: b.text, text_elements: [] };
    }
    if (b.type === 'image') {
      if (typeof b.source?.url === 'string') return { type: 'image', url: b.source.url };
      if (typeof b.source?.data === 'string') {
        const mime = b.source.media_type ?? 'image/png';
        return { type: 'image', url: `data:${mime};base64,${b.source.data}` };
      }
    }
    return null;
  }

  async function startTurn(input: CodexUserInput[]): Promise<void> {
    if (threadId === null) {
      throw new Error('CodexCliEngine: no active thread (start() not called)');
    }
    if (rpc === null) {
      throw new Error('CodexCliEngine: RPC client not initialized');
    }
    await rpc.request('turn/start', {
      threadId,
      input,
      approvalPolicy: permissionSettings.approvalPolicy,
      sandboxPolicy: permissionSettings.sandbox,
      ...(modelOverride ? { model: modelOverride } : {}),
    });
  }

  async function send(text: string): Promise<void> {
    await startTurn([{ type: 'text', text, text_elements: [] }]);
  }

  async function sendStructured(content: unknown[]): Promise<void> {
    const input = content.map(toUserInput).filter((x): x is CodexUserInput => x !== null);
    if (input.length === 0) return;
    await startTurn(input);
  }

  async function interrupt(): Promise<void> {
    // No turn in flight is the normal case for a double-press or a stop
    // click landing after completion — not an error.
    if (threadId === null || currentTurnId === null || rpc === null) return;
    await rpc.request('turn/interrupt', { threadId, turnId: currentTurnId });
  }

  async function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<void> {
    if (rpc === null) {
      throw new Error('CodexCliEngine.respondPermission: RPC client not initialized');
    }
    // The wire id may be numeric. Replying with the stringified copy we
    // handed the UI would not match the server's pending request.
    const originalId = pendingApprovals.get(requestId) ?? requestId;
    pendingApprovals.delete(requestId);
    rpc.respondToServer(originalId, {
      result: { decision: decision === 'allow' ? 'approved' : 'denied' },
    });
  }
```

Add `let modelOverride: string | null = null;` beside the other state (Task 6 sets it). Clear `currentTurnId` and `pendingApprovals` in both `close()` and `kill()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agents/codex-cli-engine.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/agents/codex-cli-engine.ts electron/__tests__/agents/codex-cli-engine.test.ts
git commit -m "feat(codex): wire turns, interrupt and the approval id round-trip"
```

---

### Task 6: Engine — `sendControlRequest` translation and `applyExtendedPermissionMode`

Unblocks `models.ts` and `commands-catalog.ts`, which currently throw on every Codex tab.

**Files:**
- Modify: `electron/services/agents/codex-cli-engine.ts`
- Test: `electron/__tests__/agents/codex-cli-engine.test.ts`

**Interfaces:**
- Consumes: Task 5's engine, `CodexUnsupportedControl` and `CodexModelListResult` (Task 2).
- Produces: `sendControlRequest` answering `initialize`, `set_model`, `set_permission_mode`, `mcp_status`, `get_context_usage`; `applyExtendedPermissionMode` no longer throwing.

- [ ] **Step 1: Write the failing test**

```ts
describe('sendControlRequest translation', () => {
  it("'initialize' answers from model/list and includes an empty commands list", async () => {
    const { engine, fake } = await startedEngine();
    const pending = engine.sendControlRequest<{ models: unknown[]; commands: unknown[] }>('initialize');
    await flushMicrotasks();

    const frame = writtenFrames(fake)[0] as { id: number; method: string };
    expect(frame.method).toBe('model/list');
    serverSend(fake, {
      id: frame.id,
      result: { data: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }], nextCursor: null },
    });

    const res = await pending;
    expect(res.models).toHaveLength(1);
    // commands-catalog.ts reads .commands off this — an absent key throws there.
    expect(res.commands).toEqual([]);
    engine.kill();
  });

  it("'set_model' stores an override applied to the next turn/start", async () => {
    const { engine, fake } = await startedEngine();
    await engine.sendControlRequest('set_model', { model: 'gpt-5.5-codex' });
    fake.stdin._writes.length = 0;

    void engine.send('hi');
    await flushMicrotasks();
    expect(writtenFrames(fake)[0]).toMatchObject({
      method: 'turn/start', params: { model: 'gpt-5.5-codex' },
    });
    engine.kill();
  });

  it("'set_permission_mode' remaps approvalPolicy and sandbox for the next turn", async () => {
    const { engine, fake } = await startedEngine();
    await engine.sendControlRequest('set_permission_mode', { mode: 'bypassPermissions' });
    fake.stdin._writes.length = 0;

    void engine.send('hi');
    await flushMicrotasks();
    expect(writtenFrames(fake)[0]).toMatchObject({
      method: 'turn/start',
      params: { approvalPolicy: 'never', sandboxPolicy: 'danger-full-access' },
    });
    engine.kill();
  });

  it("'mcp_status' maps mcpServerStatus/list into { mcpServers }", async () => {
    const { engine, fake } = await startedEngine();
    const pending = engine.sendControlRequest<{ mcpServers: unknown[] }>('mcp_status');
    await flushMicrotasks();
    const frame = writtenFrames(fake)[0] as { id: number; method: string };
    expect(frame.method).toBe('mcpServerStatus/list');
    serverSend(fake, { id: frame.id, result: { servers: [{ name: 'context7', status: 'ready' }] } });

    expect((await pending).mcpServers).toHaveLength(1);
    engine.kill();
  });

  it("'get_context_usage' returns the last thread/tokenUsage/updated payload", async () => {
    const { engine, fake } = await startedEngine();
    serverSend(fake, {
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-abc', inputTokens: 100 },
    });
    await flushMicrotasks();

    const res = await engine.sendControlRequest<{ inputTokens: number }>('get_context_usage');
    expect(res.inputTokens).toBe(100);
    engine.kill();
  });

  it('throws CodexUnsupportedControl for a subtype with no Codex equivalent', async () => {
    const { engine } = await startedEngine();
    await expect(engine.sendControlRequest('apply_flag_settings', { fastMode: true }))
      .rejects.toThrow(CodexUnsupportedControl);
    engine.kill();
  });

  it('applyExtendedPermissionMode no longer throws and takes effect on the next turn', async () => {
    const { engine, fake } = await startedEngine();
    await engine.applyExtendedPermissionMode('plan');
    fake.stdin._writes.length = 0;

    void engine.send('hi');
    await flushMicrotasks();
    expect(writtenFrames(fake)[0]).toMatchObject({
      params: { approvalPolicy: 'untrusted', sandboxPolicy: 'read-only' },
    });
    engine.kill();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/agents/codex-cli-engine.test.ts -t 'sendControlRequest translation'`
Expected: FAIL — `not yet wired`

- [ ] **Step 3: Write the implementation**

Add `let lastTokenUsage: unknown = null;` to the module state, and capture it in `onNotification`:

```ts
    } else if (method === 'thread/tokenUsage/updated') {
      lastTokenUsage = params;
    }
```

Replace the two stubs:

```ts
  async function applyExtendedPermissionMode(mode: string): Promise<void> {
    // Codex has no live "set mode" call — approvalPolicy and sandbox are
    // documented as "this turn and subsequent turns" overrides on
    // turn/start, so we store and apply on the next turn.
    permissionSettings = mapPermissionMode(mode);
  }

  async function sendControlRequest<T = unknown>(
    subtype: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (rpc === null) {
      throw new Error('CodexCliEngine.sendControlRequest: RPC client not initialized');
    }
    switch (subtype) {
      case 'initialize': {
        const res = await rpc.request<CodexModelListResult>('model/list', {});
        // commands-catalog.ts reads `.commands` off this result; Codex has
        // no slash-command catalog, and an absent key throws there.
        return { models: res?.data ?? [], commands: [] } as T;
      }
      case 'set_model': {
        const model = params?.model;
        modelOverride = typeof model === 'string' ? model : null;
        return { model: modelOverride } as T;
      }
      case 'set_permission_mode': {
        const mode = params?.mode;
        permissionSettings = mapPermissionMode(typeof mode === 'string' ? mode : undefined);
        return { mode } as T;
      }
      case 'mcp_status': {
        const res = await rpc.request<{ servers?: unknown[] }>('mcpServerStatus/list', {});
        return { mcpServers: res?.servers ?? [] } as T;
      }
      case 'get_context_usage':
        return (lastTokenUsage ?? {}) as T;
      default:
        // Loud and specific: the caller can disable the affordance rather
        // than surface a generic failure.
        throw new CodexUnsupportedControl(subtype);
    }
  }
```

Also set `getInitData()` to return the cached models rather than `null`: store the `model/list` result in a `let initData: InitData | null = null;` on the `initialize` branch and return it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agents/codex-cli-engine.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/agents/codex-cli-engine.ts electron/__tests__/agents/codex-cli-engine.test.ts
git commit -m "feat(codex): translate the cross-agent control surface onto app-server calls"
```

---

### Task 7: Version floor in `codex-binary.ts`

A binary below 0.135.0 has no `app-server` subcommand and will hang the handshake. Fail with a sentence instead.

**Files:**
- Modify: `electron/services/agents/codex-binary.ts`
- Modify: `electron/services/sessions/lifecycle.ts:218-231` (the codex branch of `start()`)
- Test: `electron/__tests__/agents/codex-binary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SUPPORTED_CODEX_VERSION: string`, `isCodexVersionSupported(version: string | null): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { SUPPORTED_CODEX_VERSION, isCodexVersionSupported } from '../../services/agents/codex-binary';

describe('isCodexVersionSupported', () => {
  it('pins the floor at the version this engine was written against', () => {
    expect(SUPPORTED_CODEX_VERSION).toBe('0.135.0');
  });

  it.each(['0.135.0', '0.135.1', '0.136.0', '1.0.0'])('accepts %s', (v) => {
    expect(isCodexVersionSupported(v)).toBe(true);
  });

  it.each(['0.134.9', '0.99.0', '0.42.0'])('rejects %s', (v) => {
    expect(isCodexVersionSupported(v)).toBe(false);
  });

  it('tolerates prerelease suffixes', () => {
    expect(isCodexVersionSupported('0.135.0-alpha.1')).toBe(true);
  });

  it('accepts an unknown version rather than blocking the user', () => {
    // We can fail to read --version for reasons that have nothing to do
    // with the version being old. Let the handshake be the judge.
    expect(isCodexVersionSupported(null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/agents/codex-binary.test.ts`
Expected: FAIL — no such export

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * The codex-cli release this engine's protocol was verified against.
 * `codex app-server` is marked experimental and its method names have
 * already been renamed once (`newConversation` → `thread/start`), which is
 * what broke Codex support for three months. Same idea as
 * REVIEWED_CLI_VERSION in claude-cli-review.ts: below the floor we refuse
 * with a sentence; above it we proceed and let the handshake speak.
 */
export const SUPPORTED_CODEX_VERSION = '0.135.0';

export function isCodexVersionSupported(version: string | null): boolean {
  if (!version) return true;
  const parse = (v: string): number[] =>
    v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(version);
  const [bMaj, bMin, bPatch] = parse(SUPPORTED_CODEX_VERSION);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch >= bPatch;
}
```

Then in `lifecycle.ts`, inside the `agent === 'codex'` branch, after the binary is found:

```ts
      const codexVersion = getCodexVersion(codexPath);
      if (!isCodexVersionSupported(codexVersion)) {
        sendToRenderer(`session-status:${tabId}`, { sessionStatus: 'error' });
        sendToRenderer(
          `agent-error:${tabId}`,
          `Codex CLI ${codexVersion} is too old for OmniFex — ` +
            `${SUPPORTED_CODEX_VERSION} or newer is required (run \`codex update\`).`,
        );
        sendToRenderer(`agent-complete:${tabId}`);
        return;
      }
```

Export `getCodexVersion(binaryPath: string): string | null` from `codex-binary.ts` by lifting the existing `getVersion` helper (currently module-private at line 36).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/agents/codex-binary.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/agents/codex-binary.ts electron/services/sessions/lifecycle.ts electron/__tests__/agents/codex-binary.test.ts
git commit -m "feat(codex): refuse binaries below the verified app-server floor"
```

---

### Task 8: Engine-aware account resolution

`main.ts:877` hardcodes the Claude slot. With Task 4 landed, a Codex cold start would set `CODEX_HOME` to a Claude config dir.

**Files:**
- Modify: `electron/services/sessions/lifecycle.ts:79` (resolver signature), `:155` (call site)
- Modify: `electron/main.ts:877`
- Test: `electron/__tests__/sessions-account-resolution.test.ts`

**Interfaces:**
- Consumes: `AccountsService.resolve(projectPath): ResolvePair` (already returns `{ claude, codex }`).
- Produces: `resolveAccountConfigDir: ((projectPath: string, engine: AgentKind) => string | null) | null`

- [ ] **Step 1: Write the failing test**

```ts
it('resolves the codex slot for a codex session, not the claude slot', () => {
  const seen: Array<[string, string]> = [];
  const service = createSessionsService(
    sendToRenderer, {}, null, null, null, null, null,
    (projectPath: string, engine: string) => {
      seen.push([projectPath, engine]);
      return engine === 'codex' ? '/Users/x/.codex-personal' : '/Users/x/.claude-work';
    },
  );

  service.start({
    tabId: 't1', projectPath: '/p', agent: 'codex', mode: 'rich', configDir: '/stale',
  });

  expect(seen).toContainEqual(['/p', 'codex']);
  expect(vi.mocked(createCodexCliEngine)).toHaveBeenCalled();
  const startArgs = stubEngineStartArgs();
  expect(startArgs.configDir).toBe('/Users/x/.codex-personal');
});

it('still resolves the claude slot for a claude session', () => {
  const service = createSessionsService(
    sendToRenderer, {}, null, null, null, null, null,
    (_p: string, engine: string) =>
      engine === 'codex' ? '/Users/x/.codex-personal' : '/Users/x/.claude-work',
  );

  service.start({ tabId: 't2', projectPath: '/p', agent: 'claude', mode: 'rich', configDir: '/stale' });

  expect(stubEngineStartArgs().configDir).toBe('/Users/x/.claude-work');
});
```

`stubEngineStartArgs()` reads the `start()` params off the mocked engine returned by `makeStubEngine` — the file already mocks both engine factories at the top; extend `makeStubEngine` to record its `start()` argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/sessions-account-resolution.test.ts`
Expected: FAIL — resolver is called with one argument, Codex session gets the Claude dir

- [ ] **Step 3: Write minimal implementation**

`lifecycle.ts` — widen the parameter type:

```ts
  resolveAccountConfigDir:
    ((projectPath: string, engine: AgentKind) => string | null) | null = null,
```

Move the `agent` derivation above the re-resolve block (it is currently computed at line 216, after) and pass it:

```ts
    const agent: AgentKind = params.agent ?? 'claude';
    …
      const resolved = resolveAccountConfigDir(projectPath, agent);
```

`main.ts:877`:

```ts
    // Account re-resolver, per engine. The Codex slot is a different
    // account from the Claude slot for the same project — resolving Codex
    // through `.claude` would hand CODEX_HOME a Claude config dir.
    (projectPath: string, engine: 'claude' | 'codex') =>
      accountsService.resolve(projectPath)[engine]?.account.config_dir ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/sessions-account-resolution.test.ts && npm run check && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions/lifecycle.ts electron/main.ts electron/__tests__/sessions-account-resolution.test.ts
git commit -m "fix(codex): resolve the codex account slot for codex sessions"
```

---

### Task 9: Transcript reducer (pure)

The wire emits `item/started` → N deltas → `item/completed` for one `item.id`. The current append-only list with `key={idx}` would render three cards per item.

**Files:**
- Create: `src/lib/codexTranscriptModel.ts`
- Test: `src/lib/__tests__/codexTranscriptModel.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` from `@/lib/api`.
- Produces: `foldCodexMessages(messages: AgentMessage[]): CodexItem[]` and `interface CodexItem { id: string; type: string; status: 'running' | 'complete'; item: Record<string, unknown>; textDelta: string; outputDelta: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { foldCodexMessages } from '@/lib/codexTranscriptModel';
import type { AgentMessage } from '@/lib/api';

const msg = (method: string, params: unknown): AgentMessage => ({
  agent: 'codex', tabId: 't', receivedAt: '2026-08-28T00:00:00Z',
  sessionId: 'thread-1', payload: { method, params },
});

describe('foldCodexMessages', () => {
  it('collapses started + completed for one item id into a single entry', () => {
    const out = foldCodexMessages([
      msg('item/started',   { item: { type: 'agentMessage', id: 'i1', text: '' }, threadId: 'x', turnId: 'y' }),
      msg('item/completed', { item: { type: 'agentMessage', id: 'i1', text: 'done' }, threadId: 'x', turnId: 'y' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'i1', type: 'agentMessage', status: 'complete' });
    expect(out[0].item.text).toBe('done');
  });

  it('preserves first-seen order across interleaved items', () => {
    const out = foldCodexMessages([
      msg('item/started',   { item: { type: 'reasoning', id: 'a' } }),
      msg('item/started',   { item: { type: 'agentMessage', id: 'b' } }),
      msg('item/completed', { item: { type: 'reasoning', id: 'a' } }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('accumulates agentMessage deltas onto the running item', () => {
    const out = foldCodexMessages([
      msg('item/started', { item: { type: 'agentMessage', id: 'i1', text: '' } }),
      msg('item/agentMessage/delta', { itemId: 'i1', delta: 'Hel' }),
      msg('item/agentMessage/delta', { itemId: 'i1', delta: 'lo' }),
    ]);
    expect(out[0].textDelta).toBe('Hello');
    expect(out[0].status).toBe('running');
  });

  it('accumulates reasoning text deltas', () => {
    const out = foldCodexMessages([
      msg('item/started', { item: { type: 'reasoning', id: 'r1' } }),
      msg('item/reasoning/textDelta', { itemId: 'r1', delta: 'think' }),
    ]);
    expect(out[0].textDelta).toBe('think');
  });

  it('accumulates command output deltas separately from text', () => {
    const out = foldCodexMessages([
      msg('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls' } }),
      msg('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'a.ts\n' }),
      msg('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'b.ts\n' }),
    ]);
    expect(out[0].outputDelta).toBe('a.ts\nb.ts\n');
    expect(out[0].textDelta).toBe('');
  });

  it('drops turn and thread lifecycle notifications — they are not cards', () => {
    const out = foldCodexMessages([
      msg('thread/started', { thread: { id: 'x' } }),
      msg('turn/started', { threadId: 'x', turn: { id: 't1' } }),
      msg('turn/completed', { threadId: 'x', turn: { id: 't1' } }),
      msg('thread/tokenUsage/updated', { threadId: 'x' }),
      msg('mcpServer/startupStatus/updated', { name: 'context7', status: 'ready' }),
    ]);
    expect(out).toEqual([]);
  });

  it('ignores a delta for an item it has not seen started', () => {
    const out = foldCodexMessages([msg('item/agentMessage/delta', { itemId: 'ghost', delta: 'x' })]);
    expect(out).toEqual([]);
  });

  it('ignores non-Codex payloads on the same channel', () => {
    const claudeish = {
      agent: 'claude', tabId: 't', receivedAt: '', sessionId: null,
      payload: { type: 'assistant', message: {} },
    } as unknown as AgentMessage;
    expect(foldCodexMessages([claudeish])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/codexTranscriptModel.test.ts`
Expected: FAIL — cannot resolve `@/lib/codexTranscriptModel`

- [ ] **Step 3: Write minimal implementation**

```ts
import type { AgentMessage } from '@/lib/api';

export interface CodexItem {
  id: string;
  type: string;
  status: 'running' | 'complete';
  /** Latest full item payload from item/started or item/completed. */
  item: Record<string, unknown>;
  /** Accumulated message/reasoning text deltas. */
  textDelta: string;
  /** Accumulated command / file-change output deltas. */
  outputDelta: string;
}

const TEXT_DELTA_METHODS = new Set([
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/plan/delta',
]);

const OUTPUT_DELTA_METHODS = new Set([
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
]);

/**
 * Fold the raw app-server notification stream into ordered, keyed cards.
 *
 * The protocol emits `item/started` → N deltas → `item/completed` for one
 * `item.id`. Rendering that as an append-only list produces three cards
 * per item, which is what the pre-rebuild transcript did. Pure and
 * separate from the component so the wire shapes can be pinned by test.
 */
export function foldCodexMessages(messages: AgentMessage[]): CodexItem[] {
  const byId = new Map<string, CodexItem>();
  const order: string[] = [];

  for (const msg of messages) {
    const payload = msg.payload;
    if (!payload || typeof payload !== 'object') continue;
    const { method, params } = payload as { method?: unknown; params?: unknown };
    if (typeof method !== 'string' || !params || typeof params !== 'object') continue;
    const p = params as Record<string, unknown>;

    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item as Record<string, unknown> | undefined;
      const id = typeof item?.id === 'string' ? item.id : null;
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing) order.push(id);
      byId.set(id, {
        id,
        type: typeof item?.type === 'string' ? item.type : 'unknown',
        status: method === 'item/completed' ? 'complete' : 'running',
        item: item ?? {},
        textDelta: existing?.textDelta ?? '',
        outputDelta: existing?.outputDelta ?? '',
      });
      continue;
    }

    if (TEXT_DELTA_METHODS.has(method) || OUTPUT_DELTA_METHODS.has(method)) {
      const id = typeof p.itemId === 'string' ? p.itemId : null;
      const delta = typeof p.delta === 'string' ? p.delta : '';
      if (!id || !delta) continue;
      const existing = byId.get(id);
      // A delta with no started item is a stream we joined mid-flight —
      // there is no card to attach it to, and inventing one would render
      // a typeless fallback.
      if (!existing) continue;
      byId.set(id, TEXT_DELTA_METHODS.has(method)
        ? { ...existing, textDelta: existing.textDelta + delta }
        : { ...existing, outputDelta: existing.outputDelta + delta });
    }
    // Everything else — thread/*, turn/*, mcpServer/*, account/* — is
    // status, not a transcript card.
  }

  return order.map((id) => byId.get(id)!);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/codexTranscriptModel.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/codexTranscriptModel.ts src/lib/__tests__/codexTranscriptModel.test.ts
git commit -m "feat(codex): fold app-server notifications into keyed transcript items"
```

---

### Task 10: Re-point the transcript and item components

**Files:**
- Modify: `src/components/codex/CodexTranscript.tsx`
- Modify: `src/components/codex/items/{AgentMessage,AgentReasoning,ExecCommand,ApplyPatch,WebSearch,McpToolCall,CodexItemFallback}.tsx`
- Test: `src/components/__tests__/CodexTranscript.test.tsx` and the six `Codex*.test.tsx` component tests

**Interfaces:**
- Consumes: `foldCodexMessages`, `CodexItem` (Task 9).
- Produces: item components taking `{ item }: { item: CodexItem }` instead of `{ message }: { message: AgentMessage }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/__tests__/CodexTranscript.test.tsx
it('renders one card per item id, not one per notification', () => {
  const messages = [
    msg('item/started',   { item: { type: 'agentMessage', id: 'i1', text: '' } }),
    msg('item/agentMessage/delta', { itemId: 'i1', delta: 'Hello' }),
    msg('item/completed', { item: { type: 'agentMessage', id: 'i1', text: 'Hello' } }),
  ];
  render(<CodexTranscript messages={messages} tabId="t" />);
  expect(screen.getAllByTestId('codex-item')).toHaveLength(1);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});

it('dispatches on ThreadItem.type', () => {
  render(<CodexTranscript tabId="t" messages={[
    msg('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', status: 'completed', exitCode: 0 } }),
  ]} />);
  expect(screen.getByText(/ls -la/)).toBeInTheDocument();
});

it('renders an unknown item type through the fallback rather than dropping it', () => {
  render(<CodexTranscript tabId="t" messages={[
    msg('item/completed', { item: { type: 'imageGeneration', id: 'g1' } }),
  ]} />);
  expect(screen.getByTestId('codex-item-fallback')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/CodexTranscript.test.tsx`
Expected: FAIL — the dispatch table still keys on `agent_message` / `item.exec_command`, so everything renders as fallback

- [ ] **Step 3: Write the implementation**

`CodexTranscript.tsx`:

```tsx
import { foldCodexMessages, type CodexItem } from "@/lib/codexTranscriptModel";

type ItemComponent = React.ComponentType<{ item: CodexItem }>;

/**
 * Dispatch on `ThreadItem.type` — the app-server protocol's own
 * discriminator. The pre-rebuild table keyed on notification method
 * names (`agent_message`, `item.exec_command`) that the wire has never
 * emitted since the app-server rename.
 */
const ITEM_COMPONENTS: Record<string, ItemComponent> = {
  agentMessage: AgentMessageItem,
  reasoning: AgentReasoningItem,
  commandExecution: ExecCommandItem,
  fileChange: ApplyPatchItem,
  webSearch: WebSearchItem,
  mcpToolCall: McpToolCallItem,
};

export function CodexTranscript({ messages, tabId: _tabId }: CodexTranscriptProps): React.ReactElement {
  const items = React.useMemo(() => foldCodexMessages(messages), [messages]);
  return (
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30 relative">
      <div className="h-full overflow-y-auto relative border border-border/50 rounded-lg bg-background">
        <div className="w-full px-4 pt-8 pb-4 space-y-4">
          {items.map((item) => {
            const Component = ITEM_COMPONENTS[item.type] ?? CodexItemFallback;
            // Keyed by the protocol's own stable item id — the old
            // index key was only safe because the list was append-only,
            // which it no longer is.
            return (
              <div key={item.id} data-testid="codex-item">
                <Component item={item} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

Each item component changes its prop from `message: AgentMessage` to `item: CodexItem` and reads the fields named in `codex-protocol.ts` §`CodexThreadItem`:

- `AgentMessage.tsx` — `item.item.text as string`, falling back to `item.textDelta` while `status === 'running'`.
- `AgentReasoning.tsx` — `item.item.summary as string[]` / `item.item.content as string[]`, falling back to `item.textDelta`.
- `ExecCommand.tsx` — `command`, `status`, `exitCode`, `durationMs`, and `aggregatedOutput ?? item.outputDelta`.
- `ApplyPatch.tsx` — `changes`, `status`.
- `WebSearch.tsx` — `query`.
- `McpToolCall.tsx` — `server`, `tool`, `status`, `arguments`, `durationMs`.
- `CodexItemFallback.tsx` — add `data-testid="codex-item-fallback"` and pretty-print `item.item`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/__tests__/Codex && npm run check && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/codex src/components/__tests__
git commit -m "feat(codex): render app-server thread items keyed by item id"
```

---

### Task 11: Documentation and full gate

**Files:**
- Modify: `CLAUDE.md` (the "multi-engine app" paragraph and the Multi-Account Rules section)
- Modify: `electron/services/auth/codex-auth.ts` (docblock — it is now accurate rather than aspirational)

- [ ] **Step 1: Update CLAUDE.md**

Replace the paragraph at `CLAUDE.md:151`:

```markdown
This is a multi-engine app (Claude + Codex). Codex drives `codex app-server`
over stdio JSON-RPC and requires codex-cli ≥ 0.135.0 — the floor is pinned
as `SUPPORTED_CODEX_VERSION` in `electron/services/agents/codex-binary.ts`.
The protocol is marked experimental upstream and has already been renamed
once; regenerate the authoritative bindings with
`codex app-server generate-ts --out /tmp/codex-proto` when auditing an
upgrade. Codex sessions ARE account-scoped: the engine sets `CODEX_HOME`
from the resolved account's config dir. See
`docs/superpowers/specs/2026-08-28-codex-app-server-rebuild-design.md`.
```

In Multi-Account Rules, replace the Codex exclusion note:

```markdown
Codex is excluded from step 3: it has no per-account `projects/<encoded>`
layout, so there is no equivalent on-disk evidence. Codex resolution is
override → path rule → `null`. Sessions are account-scoped by `CODEX_HOME`,
and the re-resolver in `main.ts` is engine-aware — resolving a Codex session
through the Claude slot would hand `CODEX_HOME` a Claude config dir.
```

- [ ] **Step 2: Run the full verification gate**

Run: `npm run check && npm test 2>&1 | tee /tmp/codex-rebuild-tests.log && npm run build`
Expected: all green. Capture the log — do not re-run to find a failure name (see `feedback_capture_test_output`).

- [ ] **Step 3: Restore the Electron ABI**

Run: `npm run rebuild:electron`

- [ ] **Step 4: Manual smoke test**

Run `npm start`, open a project, start a Codex session, send "list the files in this directory", approve the exec request, then interrupt a long turn. Confirm: one card per item, streaming text, working approve/deny, and the session resumes after a restart.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md electron/services/auth/codex-auth.ts
git commit -m "docs: record the Codex app-server rebuild and per-account CODEX_HOME"
```

---

## Self-review notes

- **Spec coverage:** §5.1 → Task 4. §5.2 → Tasks 2, 7. §5.3 → Tasks 4, 5, 6. §5.4 → Task 6. §5.5 → Task 3. §5.6 → Tasks 9, 10. §5.7 → Tasks 4, 8. §5.8 → Tasks 1, 5. §6 → every task plus Task 11.
- **Deliberately deferred:** Codex cost ingest and Codex TUI mode are non-goals (§3), not gaps.
- **Ordering constraint:** Task 8 must land with or after Task 4. Before Task 4 the engine discards `configDir`, so Task 8 alone is inert; after Task 4 but without Task 8, a Codex session gets a Claude `CODEX_HOME`. Do not ship Task 4 to `main` without Task 8.
