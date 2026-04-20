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

export type SessionStatus = 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error';

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
  setAutoAllow(tabId: string, enabled: boolean): void;
  addAutoAllowTool(tabId: string, toolName: string): void;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
  getStatus(tabId: string): SessionStatus;
  getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null;
  getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null };
  isActive(tabId: string): boolean;

  // --- Wave 2: Query-method passthroughs ----------------------------------
  /** Interrupt the current assistant turn without ending the session. */
  interrupt(tabId: string): Promise<void>;
  /** Switch the model used for subsequent turns. */
  setModel(tabId: string, model?: string): Promise<void>;
  /** Switch the permission mode mid-session. */
  setPermissionMode(tabId: string, mode: PermissionMode): Promise<void>;
  /** Change effort level mid-session. null clears the override and reverts to the SDK default. */
  setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void>;
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
}

export type SendToRenderer = (channel: string, ...args: unknown[]) => void;

export interface NotificationHooks {
  /** Show a native OS notification */
  showNotification?: (title: string, body: string, isError: boolean) => void;
  /** Increment unread count / update dock badge */
  incrementUnread?: () => void;
}

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
    destination: 'session' | 'projectSettings' | 'userSettings';
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
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  /** Queue of permission requests waiting for user response */
  permissionQueue: PendingPermission[];
  /** Resolver for a pending elicitation (MCP server asking the user a question). */
  elicitationResolver: ((decision: ElicitationDecision) => void) | null;
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
  projectPath: string;
  configDir: string;
  /** Saved SDK options so we can restart the query after a stream error. */
  sdkOptions: Record<string, unknown>;
}

// Re-export LoggingService so other modules in this folder can import from types
export type { LoggingService };
