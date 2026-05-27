// Sessions module — shared types
// Extracted from electron/services/sessions.ts (pure refactor)

import type { LoggingService } from '../logging';
import type { AgentEngine, AgentKind, InitData } from '../agents/types';

// ---------------------------------------------------------------------------
// SDK type re-exports (now defined locally — SDK dep removed)
// ---------------------------------------------------------------------------
//
// The SDK formerly owned these shapes; the CLI emits the same payloads
// over stream-json, so we keep the type names + structures for callers
// that already use them. Marked `unknown` where the SDK type was deep —
// the runtime behavior doesn't depend on shape, only on field presence
// at the call site.

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

export interface AccountInfo {
  email?: string;
  organizationName?: string;
  organizationRole?: string;
  [k: string]: unknown;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  [k: string]: unknown;
}

export interface AgentInfo {
  name: string;
  description?: string;
  [k: string]: unknown;
}

export interface SlashCommand {
  name: string;
  description?: string;
  [k: string]: unknown;
}

export interface McpServerStatus {
  name: string;
  status?: string;
  [k: string]: unknown;
}

export interface SDKControlGetContextUsageResponse {
  total_tokens?: number;
  remaining_tokens?: number;
  [k: string]: unknown;
}

/**
 * SDKUserMessage was an SDK input type. The CLI engine accepts text via
 * `engine.send(text)` and structured content via `engine.sendStructured(content)`,
 * so we no longer need this shape inside the sessions module — kept as
 * an opaque alias for the brief window where callers haven't migrated.
 */
export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: unknown };
  parent_tool_use_id: string | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lifecycle states. See `docs/session-lifecycle.md` for the full model.
 *
 * SessionStatus is the connection axis ("the phone call"):
 *  - starting: SDK startup/query fired, awaiting SDK system:init
 *  - started:  SDK answered; session has a GUID; ready for conversation
 *  - error:    stream errored, kept alive for retry
 *  - stopped:  cleanly closed
 *
 * ConversationStatus is now derived by the renderer from JSONL content +
 * task/subagent stores (see src/lib/sessionDerivedState.ts). Main process
 * owns sessionStatus only — the "is the CLI process up?" axis.
 */
export type SessionStatus =
  | 'starting'
  | 'started'
  | 'error'
  | 'stopped';

/**
 * Session backend toggle. `'rich'` is the structured engine-driven chat
 * UX (Claude CLI in stream-json mode); `'tui'` spawns the CLI in a PTY.
 * The literal was previously `'sdk' | 'tui'` — renamed when the SDK
 * runtime was replaced.
 */
export type SessionMode = 'rich' | 'tui';

export interface SessionStartParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  model: string;
  permissionMode: string;
  resumeSessionId?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }
    | { type: 'disabled' };
  /** webContents.id of the window that started this session — used to route tab-scoped events back to that window only. */
  ownerWebContentsId?: number;
  /**
   * Choose the session backend. Defaults to `'rich'` (engine-driven chat).
   * `'tui'` spawns the CLI in a PTY without `--resume` and drives the
   * renderer from the session's JSONL file. Use TUI mode when the user
   * prefers terminal-primary UX.
   */
  mode?: SessionMode;
  /**
   * True when the user explicitly picked a non-default account for this
   * session on the new-session form (`match_type === 'manual_override'`).
   * When true, main trusts `configDir` as-is. When false/undefined, main
   * re-resolves the account from current rules at session start — so that
   * a path-rule change between form-mount and Start-click doesn't spawn
   * the session under a stale account. Ignored when `resumeSessionId` is
   * set (resumes always anchor to the configDir that owns the JSONL).
   */
  manualAccountOverride?: boolean;
  /**
   * Which agent engine to drive this session. Defaults to `'claude'` for
   * back-compat — callers that pre-date Codex support omit this and get
   * the Claude CLI engine. Set to `'codex'` to dispatch
   * `createCodexCliEngine` instead. The session handle remembers the
   * resolved value so engine restarts pick the same factory.
   */
  agent?: AgentKind;
}

/** Lets the service tell the main process which window owns each tab, so tab-scoped events are routed per-window. */
export interface SessionOwnership {
  register(tabId: string, ownerWebContentsId: number): void;
  unregister(tabId: string): void;
}

export interface SessionsService {
  start(params: SessionStartParams): void | Promise<void>;
  /**
   * Re-attach an existing session to a (new) owner webContents without tearing
   * down the SDK query. Returns true if a session was found and re-bound,
   * false if no session exists for that tabId. Used when the renderer reloads
   * (Cmd+R) and needs to re-claim its in-flight sessions.
   */
  rebind(tabId: string, ownerWebContentsId: number): boolean;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Record<string, unknown>[]): void;
  respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
  ): void;
  respondElicitation(
    tabId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): void;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
  /** Return the configDir actually used to spawn this session — useful for
   *  callers that need to anchor JSONL or permission writes to the same
   *  account main resolved (which may differ from the renderer's cached
   *  account-resolution snapshot). */
  getConfigDir(tabId: string): string | null;
  getStatus(tabId: string): { sessionStatus: SessionStatus };
  getInfo(tabId: string): {
    sessionId: string | null;
    sessionStatus: SessionStatus;
  } | null;
  getHealth(tabId: string): {
    alive: boolean;
    sessionId: string | null;
    sessionStatus: SessionStatus;
  };
  isActive(tabId: string): boolean;
  /** Return all tab IDs that currently have a registered session handle. */
  listActiveTabIds(): string[];
  /**
   * Return tab IDs whose conversation is in-flight.
   *
   * TODO(jsonl-as-rendered): main no longer tracks conversationStatus — this
   * always returns [] since Task 3 of the jsonl-as-rendered refactor. The
   * wait-for-idle gate has moved to the renderer (see TODO.md for the
   * follow-up). The function is kept for the installer's hot path until that
   * follow-up lands.
   */
  listInFlightTabIds(): string[];
  /** Diagnostic: every registered session. Installer logs this on gate polls. */
  listSessionStatuses(): {
    tabId: string;
    sessionStatus: SessionStatus;
  }[];

  // --- Wave 2: Query-method passthroughs ----------------------------------
  /** Interrupt the current assistant turn without ending the session. */
  interrupt(tabId: string): Promise<void>;
  /** Switch the model used for subsequent turns. */
  setModel(tabId: string, model?: string): Promise<void>;
  /** Switch the permission mode mid-session. */
  setPermissionMode(tabId: string, mode: PermissionMode): Promise<void>;
  /** Change effort level mid-session. null clears the override and reverts to the SDK default. */
  setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void>;
  /**
   * Push permission rule lists into the live SDK session. Send the full
   * effective allow/deny list — applyFlagSettings shallow-replaces the
   * `permissions` key, so deltas would lose previously-pushed rules.
   */
  applyPermissions(
    tabId: string,
    permissions: { allow?: string[]; deny?: string[]; ask?: string[] },
  ): Promise<void>;
  /** Change thinking mode mid-session. */
  setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void>;
  /** Get the SDK-reported authenticated account for an active tab. Null if the tab isn't running. */
  getAccountInfo(tabId: string): Promise<AccountInfo | null>;
  /** Get the current context-window usage breakdown. Null if the tab isn't running. */
  getContextUsage(tabId: string): Promise<SDKControlGetContextUsageResponse | null>;
  /** Get the list of slash commands the SDK knows about for this session. Empty if no tab. */
  getSupportedCommands(tabId: string): Promise<SlashCommand[]>;
  /** Get the list of models the SDK knows about for this session. Empty if no tab. */
  getSupportedModels(tabId: string): Promise<ModelInfo[]>;
  /** Get the list of subagents the SDK knows about for this session. Empty if no tab. */
  getSupportedAgents(tabId: string): Promise<AgentInfo[]>;
  /** Get live MCP server status for an active session. Empty if no tab. */
  getMcpServerStatus(tabId: string): Promise<McpServerStatus[]>;
  /** Get loaded plugins for an active session, enriched with manifest data. */
  getPlugins(tabId: string, force?: boolean): Promise<import('./plugins').EnrichedPlugin[]>;
  setMode(tabId: string, mode: SessionMode): Promise<void>;
  tuiWrite(tabId: string, data: string): void;
  tuiResize(tabId: string, cols: number, rows: number): void;
  getMode(tabId: string): SessionMode | null;
}

export type SendToRenderer = (channel: string, ...args: unknown[]) => void;

export interface NotificationHooks {
  /**
   * Show a native OS notification. The optional `payload` carries context
   * (currently `{ tabId }`) delivered to the click handler so the renderer
   * can route the click back to the originating tab.
   */
  showNotification?: (
    title: string,
    body: string,
    isError: boolean,
    payload?: { tabId?: string },
    options?: { subtitle?: string },
  ) => void;
  /** Increment unread count / update dock badge */
  incrementUnread?: () => void;
}

/**
 * Forwarded to the rate-limits service on every `rate_limit_event` message
 * the SDK streams. Wired in main.ts; tests typically leave it undefined.
 */
export type RateLimitHook = (
  configDir: string,
  info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    rateLimitType?: string;
    utilization?: number;
    resetsAt?: number;
    surpassedThreshold?: number;
  },
) => void;

// ---------------------------------------------------------------------------
// Internal session handle
// ---------------------------------------------------------------------------

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  /** Permission rule updates to persist (for "Allow & Remember"). */
  updatedPermissions?: {
    type: 'addRules';
    rules: { toolName: string; ruleContent?: string }[];
    behavior: 'allow';
    destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
  }[];
  /** Set when the SDK's `AbortSignal` fired while the request was queued —
   *  i.e. the tool use was cancelled before the user responded. Treated as a
   *  deny on the way back to the SDK, but distinguished from a user-driven
   *  deny so logging and any future SDK contract that wants a richer signal
   *  has a hook. */
  aborted?: boolean;
}

export interface PendingPermission {
  requestId: string;
  resolve: (decision: PermissionDecision) => void;
}

export interface ElicitationDecision {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface SessionHandle {
  /**
   * Which agent powers this session. Pinned at handle construction so
   * the restart path knows which factory to call without re-resolving
   * from start-params. TUI cold-start sessions are always `'claude'`
   * in v1 (Codex doesn't have a TUI surface).
   */
  agent: AgentKind;
  /**
   * Drives the live session. Null only in TUI cold-start sessions, where
   * the CLI is spoken to via PTY (TuiSession), not via stream-json.
   */
  engine: AgentEngine | null;
  /**
   * Cached system:init payload (account, commands, models, agents).
   * Mirrors `engine.getInitData()` so queries.ts can read it synchronously.
   * Null until the first system:init arrives.
   */
  initData: InitData | null;
  /**
   * Remembered for queries.ts (currentPermissionMode) and for the engine
   * restart path. Starts from start() params; updated by setPermissionMode.
   */
  permissionMode: string;
  /**
   * Start params remembered so the runtime can call `engine.start({
   * resumeSessionId })` after stream-death recovery without re-resolving
   * the account or rebuilding the model/permissionMode/etc. inputs.
   */
  startParams: {
    projectPath: string;
    configDir: string;
    model?: string;
    permissionMode?: string;
  };
  sessionId: string | null;
  /** Connection axis. See docs/session-lifecycle.md. */
  sessionStatus: SessionStatus;
  mode: SessionMode;
  tui: import('./tui').TuiSession | null;
  /** Cleanup hook that detaches the current tui's data/exit forwarders. */
  tuiDetach: (() => void) | null;
  /** Stop handle for the TUI JSONL listener (null in rich mode). */
  tuiJsonl: import('./tui-jsonl').TuiJsonlHandle | null;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  /** Queue of permission requests waiting for user response */
  permissionQueue: PendingPermission[];
  /** Resolver for a pending elicitation (MCP server asking the user a question). */
  elicitationResolver: ((decision: ElicitationDecision) => void) | null;
  projectPath: string;
  configDir: string;
}

/**
 * Optional callback the sessions service calls to persist an accepted
 * permission rule to disk. Main.ts wires this to permissions-io's
 * updatePermission; tests pass a vi.fn(). Omitted / null → rules are only
 * handed to the SDK (in-memory for the session).
 */
export type PersistPermissionRuleFn = (params: {
  scope: 'user' | 'project' | 'local';
  behavior: 'allow' | 'deny';
  rule: string;
  configDir: string;
  projectPath: string;
}) => void;

// Re-export LoggingService so other modules in this folder can import from types
export type { LoggingService };
