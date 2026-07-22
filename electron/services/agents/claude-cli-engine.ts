import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildClaudeEnv } from '../util/claude-env';
import { createAssistantResolver } from './assistantMeta';
import { createControlRequestRegistry } from './control-request-registry';
import type {
  AgentEngine,
  AgentEngineExit,
  AgentMessage,
  AgentPermissionRequest,
  AgentStartParams,
  Disposable,
  InitData,
} from './types';

export interface CreateClaudeCliEngineParams {
  tabId: string;
  claudeBinaryPath: string;
}

/**
 * The CLI's argv `--permission-mode` only accepts these four values. OmniFex
 * also supports `'auto'` and `'dontAsk'` — those go via the stream-json
 * `set_permission_mode` control_request after spawn; passing them on argv
 * makes the CLI exit 1. For unsupported values we omit the argv flag (CLI
 * defaults to 'default') and reapply via control_request post-spawn.
 */
const CLI_ARGV_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

/**
 * Build the argv for `claude` in stream-json headless mode. Per the docs at
 * https://code.claude.com/docs/en/cli-reference:
 *
 *  - `--input-format`/`--output-format stream-json` enable bi-directional
 *    NDJSON over stdio (the headless protocol)
 *  - `--verbose` is required when `--output-format=stream-json` (CLI exits
 *    1 with "When using --print, --output-format=stream-json requires
 *    --verbose" otherwise)
 *  - `--include-partial-messages` enables `stream_event` token deltas
 *  - `--session-id` (cold) or `--resume` (warm) pins the session UUID at
 *    spawn so the JSONL path is known up front
 *  - `--permission-prompt-tool stdio` routes `can_use_tool` permission
 *    prompts through the stream-json channel (where we handle them)
 *    instead of trying to draw a TTY dialog
 *  - `--setting-sources=user,project,local` loads CLAUDE.md, project
 *    settings, and skills (otherwise the CLI runs in isolated mode)
 */
function buildArgs(p: AgentStartParams): string[] {
  const args: string[] = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Forward subagent text/thinking into the stream as assistant envelopes
    // tagged with parent_tool_use_id (CLI ≥2.1.211). The renderer routes
    // them to the SubagentBar row; derivation/cost/filters exclude them
    // from main-chain logic (see src/lib/subagentDispatch.ts).
    '--forward-subagent-text',
    '--permission-prompt-tool', 'stdio',
    '--setting-sources', 'user,project,local',
  ];
  if (p.resume) {
    args.push('--resume', p.sessionId);
  } else {
    args.push('--session-id', p.sessionId);
  }
  // 'default' means "let the CLI pick" — the CLI catalog exposes it as a
  // selectable entry, but as an argv value it's redundant; omit the flag.
  if (p.model && p.model !== 'default') {
    args.push('--model', p.model);
  }
  if (p.permissionMode && CLI_ARGV_PERMISSION_MODES.has(p.permissionMode)) {
    args.push('--permission-mode', p.permissionMode);
  }
  if (p.allowedTools && p.allowedTools.length > 0) {
    args.push('--allowed-tools', p.allowedTools.join(','));
  }
  return args;
}

export function createClaudeCliEngine(
  factory: CreateClaudeCliEngineParams,
): AgentEngine {
  let child: ChildProcessWithoutNullStreams | null = null;
  let sessionId: string | null = null;
  let initData: InitData | null = null;
  const messageCallbacks: Array<(m: AgentMessage) => void> = [];
  const permissionCallbacks: Array<(r: AgentPermissionRequest) => void> = [];
  const exitCallbacks: Array<(info: AgentEngineExit) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  // In-flight control_requests, with a hard timeout + exit cleanup so a
  // never-arriving control_response can't hang the awaiting promise forever
  // (the old "session_context_usage: reply was never sent" symptom).
  const pendingControlRequests = createControlRequestRegistry();
  /**
   * Permission requests originate at the CLI; we forward them to the
   * renderer and remember the originating tool_use_id keyed by request_id
   * so the eventual control_response can mirror it (the CLI echoes
   * `toolUseID` back in its PermissionResult).
   */
  const pendingPermissionToolUseIds = new Map<string, string>();
  // Reconstitutes the stop_reason + final usage that --include-partial-messages
  // defers off the committed assistant frame onto the trailing message_delta
  // overlay. The committed frame arrives BEFORE its delta, so the resolver
  // buffers it and forwards the resolved frame at message_stop. See assistantMeta.ts.
  const assistantResolver = createAssistantResolver();
  let nextRequestSeq = 1;
  let lineBuf = '';
  let stderrBuf = '';

  function emitMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      // Drop malformed lines — Claude only ever emits well-formed JSON on
      // stdout; anything else is noise that doesn't belong in the transcript.
      return;
    }
    const _peek = payload as { type?: string; subtype?: string };
    const p = payload as {
      type?: string;
      subtype?: string;
      session_id?: string;
      request_id?: string;
      request?: {
        subtype?: string;
        tool_name?: string;
        tool_use_id?: string;
        input?: unknown;
      };
      response?: {
        subtype?: string;
        request_id?: string;
        response?: unknown;
        error?: string;
      };
    };

    // Match control_response back to the awaiting sendControlRequest promise.
    // The CLI envelope is {type:'control_response', response:{subtype, request_id, response?, error?}}.
    if (p?.type === 'control_response' && p?.response?.request_id) {
      const id = p.response.request_id;
      if (p.response.subtype === 'error') {
        pendingControlRequests.fail(id, new Error(p.response.error ?? 'unknown control_response error'));
      } else {
        pendingControlRequests.settle(id, p.response.response);
      }
      return;
    }

    // Route can_use_tool to the permission UI; not the transcript stream.
    // Envelope is nested: {type:'control_request', request_id, request:{subtype:'can_use_tool', tool_name, input, tool_use_id, ...}}.
    if (p?.type === 'control_request' && p?.request?.subtype === 'can_use_tool') {
      const requestId = String(p.request_id ?? '');
      const toolUseId = p.request.tool_use_id ?? '';
      if (requestId && toolUseId) {
        pendingPermissionToolUseIds.set(requestId, toolUseId);
      }
      const req: AgentPermissionRequest = {
        agent: 'claude',
        requestId,
        kind: 'tool',
        summary: `Permission requested for tool: ${p.request.tool_name ?? 'unknown'}`,
        payload: p.request,
      };
      for (const cb of permissionCallbacks) {
        try {
          cb(req);
        } catch {
          /* subscriber threw */
        }
      }
      return;
    }

    if (p?.type === 'system' && p?.subtype === 'init') {
      if (typeof p.session_id === 'string') sessionId = p.session_id;
      // Cache catalog fields the CLI exposes on its system:init message.
      // We don't type the inner shapes here — the engine stays type-free;
      // sessions/queries.ts casts at the call site.
      const init = payload as {
        account?: unknown;
        commands?: unknown[];
        models?: unknown[];
        agents?: unknown[];
      };
      initData = {
        account: init.account,
        commands: init.commands,
        models: init.models,
        agents: init.agents,
      };
    }
    // --include-partial-messages defers the assistant's resolved stop_reason
    // and final usage onto a trailing message_delta overlay; the committed
    // {type:'assistant'} frame arrives BEFORE that delta with stop_reason:null
    // and stub usage. The resolver buffers each committed assistant, merges the
    // delta that lands within the same message bracket, and forwards the
    // resolved frame at message_stop — so downstream reads an honest stop_reason
    // (which the end-turn card, completion band, and per-message cost depend on).
    for (const forwarded of assistantResolver.resolve(payload)) {
      const msg: AgentMessage = {
        agent: 'claude',
        tabId: factory.tabId,
        receivedAt: new Date().toISOString(),
        sessionId,
        payload: forwarded,
      };
      for (const cb of messageCallbacks) {
        try {
          cb(msg);
        } catch {
          /* subscriber threw — swallow so one bad listener can't poison the rest */
        }
      }
    }
  }

  function wireStdout(stdout: NodeJS.ReadableStream): void {
    stdout.on('data', (chunk: Buffer | string) => {
      lineBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        emitMessage(line);
        nl = lineBuf.indexOf('\n');
      }
    });
  }

  function wireStderr(stderr: NodeJS.ReadableStream): void {
    stderr.on('data', (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = stderrBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line) {
          const err = new Error(line);
          for (const cb of errorCallbacks) {
            try {
              cb(err);
            } catch {
              /* subscriber threw */
            }
          }
        }
        nl = stderrBuf.indexOf('\n');
      }
    });
  }

  /**
   * Spawn the `claude` CLI in stream-json headless mode and resolve when the
   * subprocess is alive and ready to accept input.
   *
   * "Ready" here is the OS-level `'spawn'` event — the CLI accepts stdin
   * immediately after spawn. There is no application-level handshake to
   * await; the CLI doesn't emit a `system:init` until mid-first-turn (after
   * the client sends a user message), and that message is data-capture only,
   * not a readiness signal.
   *
   * Re-entrant: callers invoke this again to restart after stream death.
   * Tears down any prior child cleanly first.
   */
  async function start(p: AgentStartParams): Promise<void> {
    if (child !== null) {
      // Detach THIS engine's listeners from the outgoing child before killing
      // it. The kill is async — the old process still emits 'exit' a tick
      // later — and on the restart path the runtime sees the same SessionHandle,
      // so it can't distinguish that stale exit from a genuine session end and
      // would tear down the just-restarted session. Removing the listeners makes
      // the dying child's exit a no-op for us. (F2)
      const old = child;
      child = null;
      old.removeAllListeners('exit');
      old.removeAllListeners('error');
      try { old.stdout?.removeAllListeners(); } catch { /* ignore */ }
      try { old.stderr?.removeAllListeners(); } catch { /* ignore */ }
      try { old.kill('SIGTERM'); } catch { /* already gone */ }
    }
    lineBuf = '';
    stderrBuf = '';

    // The session UUID is pinned at spawn — caller-supplied, never derived
    // from a wire message. JSONL path becomes resolvable from this id alone.
    sessionId = p.sessionId;

    const args = buildArgs(p);
    try {
      child = spawn(factory.claudeBinaryPath, args, {
        cwd: p.projectPath,
        env: buildClaudeEnv(p.configDir),
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw err;
    }

    wireStdout(child.stdout);
    wireStderr(child.stderr);

    child.on('error', (err: Error) => {
      for (const cb of errorCallbacks) {
        try { cb(err); } catch { /* swallow */ }
      }
    });

    child.on('exit', (code, signal) => {
      const info: AgentEngineExit = { code: code ?? -1, signal };
      // Fail any in-flight control_requests now — their response can never
      // arrive once the child is gone, and waiting for each one's timeout would
      // leave the renderer's awaiting IPC calls hanging needlessly.
      pendingControlRequests.failAll(
        new Error(`control_request aborted: engine exited (code ${code ?? -1}${signal ? `, signal ${signal}` : ''})`),
      );
      for (const cb of exitCallbacks) {
        try { cb(info); } catch { /* swallow */ }
      }
    });

    // Wait for the OS-level 'spawn' event — confirms the process is alive
    // and the binary was actually exec'd. Rejects if the spawn fails (ENOENT
    // for a missing binary, EACCES, etc.) so lifecycle can transition to
    // 'error' with a useful message.
    await new Promise<void>((resolve, reject) => {
      const childRef = child!;
      const onSpawn = (): void => {
        childRef.off('error', onErr);
        resolve();
      };
      const onErr = (err: Error): void => {
        childRef.off('spawn', onSpawn);
        reject(err);
      };
      childRef.once('spawn', onSpawn);
      childRef.once('error', onErr);
    });
  }

  /**
   * Apply a permission mode the CLI's argv parser doesn't accept (`'auto'`,
   * `'dontAsk'`). Lifecycle calls this after start() resolves when the
   * caller's requested mode isn't in `CLI_ARGV_PERMISSION_MODES`. Idempotent
   * for known-CLI modes (they were already set on argv).
   */
  async function applyExtendedPermissionMode(mode: string): Promise<void> {
    if (CLI_ARGV_PERMISSION_MODES.has(mode)) return; // already pinned via argv
    try {
      await sendControlRequest('set_permission_mode', { mode });
    } catch (err) {
      // Non-fatal — CLI keeps whatever mode it defaulted to.
    }
  }

  async function writeUserMessage(content: unknown): Promise<void> {
    if (!child || !child.stdin.writable) {
      throw new Error('ClaudeCliEngine.send: child not running');
    }
    const payload = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: sessionId ?? '',
    };
    const line = JSON.stringify(payload) + '\n';
    await new Promise<void>((resolve, reject) => {
      child!.stdin.write(line, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async function send(text: string): Promise<void> {
    await writeUserMessage([{ type: 'text', text }]);
  }

  async function sendStructured(content: unknown[]): Promise<void> {
    await writeUserMessage(content);
  }

  async function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    payload?: unknown,
  ): Promise<void> {
    if (!child || !child.stdin.writable) return;
    const toolUseId = pendingPermissionToolUseIds.get(requestId) ?? '';
    pendingPermissionToolUseIds.delete(requestId);

    // Build the PermissionResult body the CLI expects. `payload` from
    // sessions/permissions.ts carries renderer-side extras like updatedInput
    // / updatedPermissions; merge them onto the base shape so the CLI sees
    // exactly the PermissionResult it expects.
    const permissionResult: Record<string, unknown> = {
      behavior: decision,
      toolUseID: toolUseId,
    };
    if (payload && typeof payload === 'object') {
      Object.assign(permissionResult, payload as Record<string, unknown>);
      // Re-pin behavior/toolUseID after the spread so a caller can't
      // accidentally clobber them.
      permissionResult.behavior = decision;
      permissionResult.toolUseID = toolUseId;
    }

    const envelope = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: permissionResult,
      },
    };
    const line = JSON.stringify(envelope) + '\n';
    await new Promise<void>((resolve, reject) => {
      child!.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function sendControlRequest<T = unknown>(
    subtype: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error('ClaudeCliEngine.sendControlRequest: child not running'));
    }
    const requestId = `req-${nextRequestSeq++}-${Date.now().toString(36)}`;
    const envelope = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype, ...(params ?? {}) },
    };
    const line = JSON.stringify(envelope) + '\n';
    const promise = pendingControlRequests.create<T>(requestId, subtype);
    child.stdin.write(line, (err) => {
      // A failed write means no response will ever come — reject now rather
      // than waiting for the timeout.
      if (err) pendingControlRequests.fail(requestId, err);
    });
    return promise;
  }

  async function interrupt(): Promise<void> {
    await sendControlRequest('interrupt');
  }

  async function close(): Promise<void> {
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      child = null;
    }
  }

  function kill(): void {
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      child = null;
    }
  }

  function getResumeId(): string | null {
    return sessionId;
  }

  function getInitData(): InitData | null {
    return initData;
  }

  function onMessage(cb: (m: AgentMessage) => void): Disposable {
    messageCallbacks.push(cb);
    return {
      dispose() {
        const i = messageCallbacks.indexOf(cb);
        if (i !== -1) messageCallbacks.splice(i, 1);
      },
    };
  }
  function onPermissionRequest(cb: (r: AgentPermissionRequest) => void): Disposable {
    permissionCallbacks.push(cb);
    return {
      dispose() {
        const i = permissionCallbacks.indexOf(cb);
        if (i !== -1) permissionCallbacks.splice(i, 1);
      },
    };
  }
  function onError(cb: (err: Error) => void): Disposable {
    errorCallbacks.push(cb);
    return {
      dispose() {
        const i = errorCallbacks.indexOf(cb);
        if (i !== -1) errorCallbacks.splice(i, 1);
      },
    };
  }
  function onExit(cb: (info: AgentEngineExit) => void): Disposable {
    exitCallbacks.push(cb);
    return {
      dispose() {
        const i = exitCallbacks.indexOf(cb);
        if (i !== -1) exitCallbacks.splice(i, 1);
      },
    };
  }

  return {
    kind: 'claude',
    start,
    applyExtendedPermissionMode,
    send,
    sendStructured,
    sendControlRequest,
    respondPermission,
    interrupt,
    close,
    kill,
    getResumeId,
    getInitData,
    onMessage,
    onPermissionRequest,
    onError,
    onExit,
  };
}
