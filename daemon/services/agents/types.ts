export type AgentKind = 'claude' | 'codex';

export interface AgentStartParams {
  projectPath: string;
  configDir: string;
  model?: string;
  permissionMode?: string;
  /** Minted by the caller and reused across engine restarts; never taken from the CLI. */
  sessionId: string;
  resume: boolean;
  allowedTools?: string[];
  effort?: string;
  claude?: Record<string, unknown>;
  codex?: Record<string, unknown>;
}

export interface AgentMessage {
  agent: AgentKind;
  tabId: string;
  receivedAt: string;
  sessionId: string | null;
  payload: unknown;
}

export interface AgentPermissionRequest {
  agent: AgentKind;
  requestId: string;
  kind: 'tool' | 'patch' | 'exec';
  summary: string;
  payload: unknown;
}

export interface AgentElicitationRequest {
  requestId: string;
  serverName: string;
  message: string;
  mode: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export interface Disposable {
  dispose(): void;
}

export interface AgentEngineExit {
  code: number;
  signal?: string | null;
}

/** Fields stay `unknown`: the engine must not import engine-specific types. */
export interface InitData {
  account?: unknown;
  commands?: unknown[];
  models?: unknown[];
  agents?: unknown[];
  /** Read so the list shows without a side-effectful reload_plugins. */
  plugins?: unknown[];
  /** An open set; absent on older CLIs. */
  capabilities?: string[];
}

export interface ControlRequestOptions {
  /** `side_question` needs far longer than the 10 s default. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentEngine {
  readonly kind: AgentKind;

  start(params: AgentStartParams): Promise<void>;
  applyExtendedPermissionMode(mode: string): Promise<void>;
  send(text: string): Promise<void>;
  sendStructured(content: unknown[]): Promise<void>;
  sendControlRequest<T = unknown>(
    subtype: string,
    params?: Record<string, unknown>,
    opts?: ControlRequestOptions,
  ): Promise<T>;
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    payload?: unknown,
  ): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  kill(): void;

  getResumeId(): string | null;

  getInitData(): InitData | null;

  onMessage(cb: (m: AgentMessage) => void): Disposable;
  onPermissionRequest(cb: (r: AgentPermissionRequest) => void): Disposable;
  onElicitationRequest?(cb: (r: AgentElicitationRequest) => void): Disposable;
  respondElicitation?(
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
  ): Promise<void>;
  onControlCancel?(cb: (requestId: string) => void): Disposable;
  onError(cb: (err: Error) => void): Disposable;
  onExit(cb: (info: AgentEngineExit) => void): Disposable;
}
