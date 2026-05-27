import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createJsonRpcClient, type JsonRpcClient } from './json-rpc-client';
import type {
  AgentEngine,
  AgentEngineExit,
  AgentMessage,
  AgentPermissionRequest,
  AgentStartParams,
  Disposable,
  InitData,
} from './types';

export interface CreateCodexCliEngineParams {
  tabId: string;
  codexBinaryPath: string;
}

/**
 * CodexCliEngine drives `codex mcp` over JSON-RPC on stdio.
 *
 * Task 4 wires only the spawn lifecycle + initial `newConversation` /
 * `resumeConversation` handshake. The rest of the AgentEngine surface
 * (send, approvals, notifications, interrupt, lifecycle wiring) is filled
 * in by Tasks 5–9; those methods throw here so a stray call surfaces
 * loudly instead of silently no-op'ing.
 *
 * v1 does NOT set `CODEX_HOME` — the plan's Non-Goals explicitly excludes
 * multi-account routing for Codex. The spawn inherits the parent env
 * MINUS `CLAUDE_CONFIG_DIR` (Claude-specific noise that shouldn't leak
 * into Codex's environment) so Codex reads the user's single `~/.codex/`
 * directory without picking up Claude account state.
 */
export function createCodexCliEngine(
  factory: CreateCodexCliEngineParams,
): AgentEngine {
  let child: ChildProcessWithoutNullStreams | null = null;
  let rpc: JsonRpcClient | null = null;
  let conversationId: string | null = null;
  const exitCallbacks: Array<(info: AgentEngineExit) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const permissionCallbacks: Array<(r: AgentPermissionRequest) => void> = [];
  const messageCallbacks: Array<(m: AgentMessage) => void> = [];

  function emitPermission(r: AgentPermissionRequest): void {
    for (const cb of permissionCallbacks) {
      try { cb(r); } catch { /* one bad handler shouldn't poison the rest */ }
    }
  }

  function emitMessage(m: AgentMessage): void {
    for (const cb of messageCallbacks) {
      try { cb(m); } catch { /* one bad handler shouldn't poison the rest */ }
    }
  }

  function onNotification(method: string, params: unknown): void {
    emitMessage({
      agent: 'codex',
      tabId: factory.tabId,
      receivedAt: new Date().toISOString(),
      sessionId: conversationId,
      payload: { method, params },
    });
  }

  function handleServerRequest(method: string, params: unknown, id: string | number): void {
    if (method === 'applyPatchApproval') {
      emitPermission({
        agent: 'codex',
        requestId: String(id),
        kind: 'patch',
        summary: 'Apply patch',
        payload: params,
      });
    } else if (method === 'execCommandApproval') {
      const p = (params ?? {}) as { command?: unknown };
      const cmd = typeof p.command === 'string' ? p.command : '<unknown>';
      emitPermission({
        agent: 'codex',
        requestId: String(id),
        kind: 'exec',
        summary: `Run: ${cmd}`,
        payload: params,
      });
    } else {
      // Unknown server-initiated method — respond with method-not-handled so
      // the server doesn't hang waiting for a response.
      if (rpc !== null) {
        rpc.respondToServer(id, {
          error: { code: -32601, message: `Method not handled: ${method}` },
        });
      }
    }
  }

  async function start(p: AgentStartParams): Promise<void> {
    if (child !== null) {
      // Drain any pending requests on the prior rpc client with a clean
      // rejection before killing the child — otherwise their promises leak.
      if (rpc) {
        rpc.close();
        rpc = null;
      }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      child = null;
    }

    // Strip CLAUDE_CONFIG_DIR from inherited env — the Electron main process
    // sets it to the current Claude account's config dir, and letting Codex
    // see it is a silent coupling we don't want. Keep everything else (PATH,
    // HOME, etc.) intact.
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;

    child = spawn(factory.codexBinaryPath, ['mcp'], {
      cwd: p.projectPath,
      env,
    }) as ChildProcessWithoutNullStreams;

    child.on('exit', (code, signal) => {
      const info: AgentEngineExit = { code: code ?? -1, signal };
      for (const cb of exitCallbacks) {
        try { cb(info); } catch { /* swallow */ }
      }
    });

    child.on('error', (err: Error) => {
      for (const cb of errorCallbacks) {
        try { cb(err); } catch { /* swallow */ }
      }
    });

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

    try {
      rpc = createJsonRpcClient({
        readable: child.stdout,
        writable: child.stdin,
        onNotification,
        onServerRequest: handleServerRequest,
      });

      if (p.resume) {
        const result = await rpc.request<{ conversationId?: string }>(
          'resumeConversation',
          { conversationId: p.sessionId, ...(p.codex ?? {}) },
        );
        conversationId = result?.conversationId ?? p.sessionId;
      } else {
        const result = await rpc.request<{ conversationId?: string }>(
          'newConversation',
          { model: p.model, ...(p.codex ?? {}) },
        );
        conversationId = result?.conversationId ?? null;
      }
    } catch (err) {
      // Handshake failed — tear down rpc + child so the caller doesn't have
      // to (and so we don't leak a child process with no handle to it).
      await close();
      throw err;
    }
  }

  // Stubs — Tasks 5–9 fill these in. Throw rather than silently no-op so a
  // missed wire-up surfaces loudly at the call site.
  async function applyExtendedPermissionMode(_mode: string): Promise<void> {
    throw new Error('CodexCliEngine.applyExtendedPermissionMode: not yet wired');
  }
  async function send(text: string): Promise<void> {
    if (conversationId === null) {
      throw new Error(
        'CodexCliEngine.send: no active conversation (start() not called or no conversationId)',
      );
    }
    if (rpc === null) {
      throw new Error('CodexCliEngine.send: RPC client not initialized');
    }
    await rpc.request('sendUserTurn', { conversationId, input: text });
  }
  async function sendStructured(_content: unknown[]): Promise<void> {
    throw new Error('CodexCliEngine.sendStructured: not yet wired');
  }
  async function sendControlRequest<T = unknown>(
    _subtype: string,
    _params?: Record<string, unknown>,
  ): Promise<T> {
    throw new Error('CodexCliEngine.sendControlRequest: not yet wired');
  }
  async function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    payload?: unknown,
  ): Promise<void> {
    if (rpc === null) {
      throw new Error('CodexCliEngine.respondPermission: RPC client not initialized');
    }
    const extra =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    // respondToServer is synchronous in the JSON-RPC client; the `async`
    // here is just to match the AgentEngine interface signature.
    rpc.respondToServer(requestId, { result: { ...extra, decision } });
  }
  async function interrupt(): Promise<void> {
    if (conversationId === null) return;
    if (rpc === null) return;
    await rpc.request('interruptConversation', { conversationId });
  }

  async function close(): Promise<void> {
    if (rpc) {
      rpc.close();
      rpc = null;
    }
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      child = null;
    }
  }

  function kill(): void {
    if (rpc) {
      rpc.close();
      rpc = null;
    }
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      child = null;
    }
  }

  function getResumeId(): string | null {
    return conversationId;
  }

  function getInitData(): InitData | null {
    // Codex doesn't have a system:init payload like Claude — init data
    // arrives via notifications. Task 7 wires the notification surface;
    // Task 4 returns null.
    return null;
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
    kind: 'codex',
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
