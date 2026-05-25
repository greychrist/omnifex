/**
 * Shared abstractions for the live agent runtime.
 *
 * Phase A ships a single concrete implementation (`ClaudeCliEngine`) that
 * shells out to `claude --output-format stream-json --input-format stream-json`.
 * Phase 3 will add a Codex implementation behind the same interface.
 *
 * The renderer continues to consume Claude's native SDKMessage shape; the
 * envelope here only normalizes routing metadata so the sessions service can
 * stay agent-agnostic.
 */

export type AgentKind = 'claude' | 'codex';

export interface AgentStartParams {
  projectPath: string;
  configDir: string;
  model?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  allowedTools?: string[];
  /** Engine-specific extras. Claude reads its own keys; others ignore. */
  claude?: Record<string, unknown>;
}

export interface AgentMessage {
  agent: AgentKind;
  tabId: string;
  receivedAt: string;
  sessionId: string | null;
  /**
   * Engine-native payload. For Claude this is the existing SDKMessage shape
   * (passed through unchanged); for Codex it's the codex/event body.
   */
  payload: unknown;
}

export interface AgentPermissionRequest {
  agent: AgentKind;
  requestId: string;
  kind: 'tool' | 'patch' | 'exec';
  summary: string;
  payload: unknown;
}

export interface Disposable {
  dispose(): void;
}

export interface AgentEngineExit {
  code: number;
  signal?: string | null;
}

export interface AgentEngine {
  readonly kind: AgentKind;

  start(params: AgentStartParams): Promise<void>;
  send(text: string): Promise<void>;
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    payload?: unknown,
  ): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  kill(): void;

  /** Resume id captured from the engine's session-start payload, if any. */
  getResumeId(): string | null;

  onMessage(cb: (m: AgentMessage) => void): Disposable;
  onPermissionRequest(cb: (r: AgentPermissionRequest) => void): Disposable;
  onError(cb: (err: Error) => void): Disposable;
  onExit(cb: (info: AgentEngineExit) => void): Disposable;
}
