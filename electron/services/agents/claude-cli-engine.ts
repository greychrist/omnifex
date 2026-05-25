import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildClaudeEnv } from '../util/claude-env';
import type {
  AgentEngine,
  AgentEngineExit,
  AgentMessage,
  AgentPermissionRequest,
  AgentStartParams,
  Disposable,
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
  const messageCallbacks: Array<(m: AgentMessage) => void> = [];
  const permissionCallbacks: Array<(r: AgentPermissionRequest) => void> = [];
  let lineBuf = '';

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
      tool_name?: string;
    };

    // Route permission requests to permission callbacks only; they don't
    // belong in the transcript stream — the renderer's UI prompt is the
    // consumer, not the message list.
    if (p?.type === 'control_request' && p?.subtype === 'permission_request') {
      const req: AgentPermissionRequest = {
        agent: 'claude',
        requestId: String(p.request_id ?? ''),
        kind: 'tool',
        summary: `Permission requested for tool: ${p.tool_name ?? 'unknown'}`,
        payload,
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

    if (p?.type === 'system' && p?.subtype === 'init' && typeof p.session_id === 'string') {
      sessionId = p.session_id;
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

  async function start(p: AgentStartParams): Promise<void> {
    sessionId = p.resumeSessionId ?? sessionId;
    const args = buildArgs(p);
    child = spawn(factory.claudeBinaryPath, args, {
      cwd: p.projectPath,
      env: buildClaudeEnv(p.configDir),
    }) as ChildProcessWithoutNullStreams;
    wireStdout(child.stdout);
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
    const obj: Record<string, unknown> = {
      type: 'control_response',
      request_id: requestId,
      decision,
    };
    if (payload !== undefined) obj.input = payload;
    const line = JSON.stringify(obj) + '\n';
    await new Promise<void>((resolve, reject) => {
      child!.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function interrupt(): Promise<void> {
    if (!child || !child.stdin.writable) return;
    const requestId = `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const obj = { type: 'control_request', subtype: 'interrupt', request_id: requestId };
    const line = JSON.stringify(obj) + '\n';
    await new Promise<void>((resolve, reject) => {
      child!.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
  function onError(_cb: (err: Error) => void): Disposable {
    return { dispose() {} };
  }
  function onExit(_cb: (info: AgentEngineExit) => void): Disposable {
    return { dispose() {} };
  }

  return {
    kind: 'claude',
    start,
    send,
    respondPermission,
    interrupt,
    close,
    kill,
    getResumeId,
    onMessage,
    onPermissionRequest,
    onError,
    onExit,
  };
}
