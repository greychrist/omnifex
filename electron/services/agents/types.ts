/**
 * Shared abstractions for the live agent runtime.
 *
 * Phase A ships a single concrete implementation (`ClaudeCliEngine`) that
 * shells out to `claude --output-format stream-json --input-format stream-json`.
 * Phase 3 will add a Codex implementation behind the same interface.
 *
 * The renderer continues to consume Claude's native CliMessage shape; the
 * envelope here only normalizes routing metadata so the sessions service can
 * stay agent-agnostic.
 */

export type AgentKind = 'claude' | 'codex';

export interface AgentStartParams {
  projectPath: string;
  configDir: string;
  model?: string;
  permissionMode?: string;
  /**
   * Stable UUID for the session. The caller mints this for cold-start
   * sessions and reuses it across engine restarts. Pinned at spawn via
   * the CLI's `--session-id` (cold) or `--resume` (warm) so the JSONL
   * path is known up front and resume after stream-death keeps the same
   * id. Required — we no longer wait for the CLI to emit one mid-turn.
   */
  sessionId: string;
  /** True when sessionId points at an existing JSONL the CLI should
   *  continue. False for fresh sessions. */
  resume: boolean;
  allowedTools?: string[];
  /** Engine-specific extras. Claude reads its own keys; others ignore. */
  claude?: Record<string, unknown>;
  /** Engine-specific extras. Codex reads its own keys; others ignore. */
  codex?: Record<string, unknown>;
}

export interface AgentMessage {
  agent: AgentKind;
  tabId: string;
  receivedAt: string;
  sessionId: string | null;
  /**
   * Engine-native payload. For Claude this is the existing CliMessage shape
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

/**
 * Engine-cached payload from the session's first system:init message.
 * The account / commands / models / agents catalogs are read from this same
 * cached payload; pulling them off the engine avoids a round-trip to the CLI
 * for data we already have.
 *
 * Fields are intentionally `unknown` at the engine layer — the sessions
 * service casts to the proper shape at the call site. Keeping the engine
 * agent-agnostic means it shouldn't import engine-specific types.
 */
export interface InitData {
  account?: unknown;
  commands?: unknown[];
  models?: unknown[];
  agents?: unknown[];
}

export interface AgentEngine {
  readonly kind: AgentKind;

  start(params: AgentStartParams): Promise<void>;
  /**
   * Apply a permission mode that the CLI's argv parser doesn't accept
   * (e.g. 'auto', 'dontAsk'). Called by lifecycle after `start()` resolves.
   * No-op for modes already set via argv. Engine-specific because Codex's
   * approval model is structured differently — kept off the cross-agent
   * `sendControlRequest` to keep that interface protocol-agnostic.
   */
  applyExtendedPermissionMode(mode: string): Promise<void>;
  send(text: string): Promise<void>;
  /**
   * Send a structured user message with explicit content blocks (text +
   * image attachments, etc.). The renderer's compose box uses this when
   * the user attaches images alongside text. `content` is the same array
   * the CLI accepts in CliUserMessage.message.content.
   */
  sendStructured(content: unknown[]): Promise<void>;
  /**
   * Write a control_request to the CLI's stdin and await its matching
   * control_response. Used for the imperative CLI query surface (set_model,
   * mcp_status, get_context_usage, …). Rejects when the CLI returns
   * `control_response.subtype: 'error'` or when the engine is torn down
   * with the request still pending.
   */
  sendControlRequest<T = unknown>(
    subtype: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
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

  /** Cached system:init payload fields, or null pre-init. */
  getInitData(): InitData | null;

  onMessage(cb: (m: AgentMessage) => void): Disposable;
  onPermissionRequest(cb: (r: AgentPermissionRequest) => void): Disposable;
  onError(cb: (err: Error) => void): Disposable;
  onExit(cb: (info: AgentEngineExit) => void): Disposable;
}
