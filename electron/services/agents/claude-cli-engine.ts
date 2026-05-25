import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildClaudeEnv } from '../util/claude-env';
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
 * Build the argv for `claude` in stream-json IO mode.
 *
 * Resume is wired via `--resume <id>`; the CLI re-emits a `system:init`
 * payload with the resumed session_id so the engine's `getResumeId()` stays
 * accurate without us doing anything extra.
 */
function buildArgs(p: AgentStartParams): string[] {
  const args: string[] = [
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
  ];
  if (p.resumeSessionId) {
    args.push('--resume', p.resumeSessionId);
  }
  if (p.model) {
    args.push('--model', p.model);
  }
  if (p.permissionMode) {
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
  const pendingControlRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /**
   * Permission requests originate at the CLI; we forward them to the
   * renderer and remember the originating tool_use_id keyed by request_id
   * so the eventual control_response can mirror it (the SDK echoes
   * `toolUseID` back in its PermissionResult).
   */
  const pendingPermissionToolUseIds = new Map<string, string>();
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
    // The SDK envelope is {type:'control_response', response:{subtype, request_id, response?, error?}}.
    if (p?.type === 'control_response' && p?.response?.request_id) {
      const id = p.response.request_id;
      const entry = pendingControlRequests.get(id);
      if (entry) {
        pendingControlRequests.delete(id);
        if (p.response.subtype === 'error') {
          entry.reject(new Error(p.response.error ?? 'unknown control_response error'));
        } else {
          entry.resolve(p.response.response);
        }
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
      // Cache catalog fields the SDK formerly exposed via Query.accountInfo()
      // and friends. We don't type the inner shapes here — the engine stays
      // SDK-type-free; sessions/queries.ts casts at the call site.
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
    const msg: AgentMessage = {
      agent: 'claude',
      tabId: factory.tabId,
      receivedAt: new Date().toISOString(),
      sessionId,
      payload,
    };
    for (const cb of messageCallbacks) {
      try {
        cb(msg);
      } catch {
        /* subscriber threw — swallow so one bad listener can't poison the rest */
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

  async function start(p: AgentStartParams): Promise<void> {
    // Re-entrant: callers use this to restart on stream death. Tear down the
    // old child first so we don't leak an unparented subprocess, and reset
    // the stdout buffer so a half-line from the dead child can't poison
    // the fresh one.
    if (child !== null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      child = null;
    }
    lineBuf = '';
    stderrBuf = '';

    sessionId = p.resumeSessionId ?? sessionId;
    const args = buildArgs(p);
    child = spawn(factory.claudeBinaryPath, args, {
      cwd: p.projectPath,
      env: buildClaudeEnv(p.configDir),
    }) as ChildProcessWithoutNullStreams;
    wireStdout(child.stdout);
    wireStderr(child.stderr);
    child.on('exit', (code, signal) => {
      const info: AgentEngineExit = { code: code ?? -1, signal };
      for (const cb of exitCallbacks) {
        try {
          cb(info);
        } catch {
          /* subscriber threw */
        }
      }
    });
  }

  async function send(text: string): Promise<void> {
    if (!child || !child.stdin.writable) {
      throw new Error('ClaudeCliEngine.send: child not running');
    }
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      session_id: sessionId ?? '',
    };
    const line = JSON.stringify(payload) + '\n';
    await new Promise<void>((resolve, reject) => {
      child!.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
    // exactly what the SDK used to send.
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
    return new Promise<T>((resolve, reject) => {
      pendingControlRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      child!.stdin.write(line, (err) => {
        if (err) {
          pendingControlRequests.delete(requestId);
          reject(err);
        }
      });
    });
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
    send,
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
