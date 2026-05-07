// Sessions module — shared types
// Extracted from electron/services/sessions.ts (pure refactor)

import type { AsyncChannel } from '../async-channel';
import type { LoggingService } from '../logging';

// ---------------------------------------------------------------------------
// SDK re-exports
// ---------------------------------------------------------------------------

import type {
  SDKUserMessage,
  Query,
  PermissionMode,
  AccountInfo,
  AgentInfo,
  ModelInfo,
  SlashCommand,
  SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';

export type {
  SDKUserMessage,
  Query,
  PermissionMode,
  AccountInfo,
  AgentInfo,
  ModelInfo,
  SlashCommand,
  SDKControlGetContextUsageResponse,
  McpServerStatus,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a session handle.
 *
 * 'running' means the SDK turn is in flight — actively producing output, or
 * about to. 'idle' means the session is alive but the last turn finished
 * (the SDK emitted a `result` message); we're sitting on the input channel
 * waiting for the user. The installer's wait-for-idle gate uses this split
 * to avoid blocking on tabs that are merely open.
 */
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'waiting_permission'
  | 'stopped'
  | 'error';

export type SessionMode = 'sdk' | 'tui';

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
}

/** Lets the service tell the main process which window owns each tab, so tab-scoped events are routed per-window. */
export interface SessionOwnership {
  register(tabId: string, ownerWebContentsId: number): void;
  unregister(tabId: string): void;
}

export interface SessionsService {
  start(params: SessionStartParams): void;
  /**
   * Re-attach an existing session to a (new) owner webContents without tearing
   * down the SDK query. Returns true if a session was found and re-bound,
   * false if no session exists for that tabId. Used when the renderer reloads
   * (Cmd+R) and needs to re-claim its in-flight sessions.
   */
  rebind(tabId: string, ownerWebContentsId: number): boolean;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): void;
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
  getStatus(tabId: string): SessionStatus;
  getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null;
  getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null };
  isActive(tabId: string): boolean;
  /** Return all tab IDs that currently have a registered session handle. */
  listActiveTabIds(): string[];
  /** Return tab IDs whose session is mid-turn — `'starting'`, `'running'`,
   *  or `'waiting_permission'`. Used by the installer to gate auto-update so
   *  that idle/open sessions don't block. */
  listInFlightTabIds(): string[];
  /** Diagnostic: every registered session paired with its current status,
   *  in-flight or not. The installer logs this on every gate poll so we can
   *  tell why the gate cleared when the renderer thinks sessions are active. */
  listSessionStatuses(): Array<{ tabId: string; status: SessionStatus }>;

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
  updatedPermissions?: Array<{
    type: 'addRules';
    rules: Array<{ toolName: string; ruleContent?: string }>;
    behavior: 'allow';
    destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
  }>;
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
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
  sessionId: string | null;
  status: SessionStatus;
  mode: SessionMode;
  tui: import('./tui').TuiSession | null;
  /** Cleanup hook that detaches the current tui's data/exit forwarders. */
  tuiDetach: (() => void) | null;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  /** Queue of permission requests waiting for user response */
  permissionQueue: PendingPermission[];
  /** Resolver for a pending elicitation (MCP server asking the user a question). */
  elicitationResolver: ((decision: ElicitationDecision) => void) | null;
  projectPath: string;
  configDir: string;
  /** Saved SDK options so we can restart the query after a stream error. */
  sdkOptions: Record<string, unknown>;
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
