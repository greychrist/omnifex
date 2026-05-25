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

  async function start(p: AgentStartParams): Promise<void> {
    sessionId = p.resumeSessionId ?? sessionId;
    const args = buildArgs(p);
    child = spawn(factory.claudeBinaryPath, args, {
      cwd: p.projectPath,
      env: buildClaudeEnv(p.configDir),
    }) as ChildProcessWithoutNullStreams;
  }

  async function send(_text: string): Promise<void> {
    // Implemented in Task 5.
  }

  async function respondPermission(
    _requestId: string,
    _decision: 'allow' | 'deny',
    _payload?: unknown,
  ): Promise<void> {
    // Implemented in Task 6.
  }

  async function interrupt(): Promise<void> {
    // Implemented in Task 7.
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

  function onMessage(_cb: (m: AgentMessage) => void): Disposable {
    return { dispose() {} };
  }
  function onPermissionRequest(_cb: (r: AgentPermissionRequest) => void): Disposable {
    return { dispose() {} };
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
