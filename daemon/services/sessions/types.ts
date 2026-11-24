import type { LoggingService } from '../logging';
import type { AgentElicitationRequest, AgentEngine, AgentKind, ElicitationAction, InitData } from '../agents/types';
import type { SideChatStore } from './side-chat';
import type { ModNoticeTracker } from './mod-notifications';
import type { SideChat, SideChatAskResult } from '../../../src/lib/sideChat';
import type { TaskOutputTail } from '../../../src/lib/backgroundShells';

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

// `detected: null` (nobody logged in) counts as a mismatch.
export interface AccountMismatch {
  expected: string;
  detected: string | null;
  configDir: string;
  source: 'oauth-file' | 'session-init';
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

export interface McpAuthResult {
  authUrl: string | null;
  requiresUserAction: boolean;
  callbackExpected: boolean;
}

export interface McpServerStatus {
  name: string;
  status?: string;
  [k: string]: unknown;
}

// Closed union on purpose: a new CLI source is drift, and `parsePermissionRulesState` drops rows it cannot classify.
export type CliPermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'
  | 'toolsNarrowing'
  | 'mcpServerPolicy'
  | 'hostCredential';

// `emphasis` is rule content and may carry invisible characters: escape it at display.
export interface CliPermissionRuleDescription {
  prefix: string;
  emphasis?: string;
  suffix?: string;
}

export interface CliPermissionRule {
  behavior: 'allow' | 'deny' | 'ask';
  source: CliPermissionRuleSource;
  // Verbatim, and may carry control characters: escape at display, never match on it without normalizing.
  rule: string;
  description?: CliPermissionRuleDescription;
  editability: 'persistent' | 'session' | 'readonly';
  notInEffect?: boolean;
}

export interface CliWorkspaceDirectory {
  path: string;
  source: string;
}

export interface CliPermissionRulesState {
  rules: CliPermissionRule[];
  workspaceDirectories: CliWorkspaceDirectory[];
  originalCwd: string;
  managedOnly: boolean;
  // Settings files skipped by the merge: their rules are not in the session.
  errors?: unknown[];
}

// `shutdown`: the process is exiting, so work started from the close hook dies with it.
export type SessionCloseReason = 'closed' | 'shutdown';

export type SessionClosedHook = (
  sessionId: string,
  projectPath: string,
  configDir: string,
  reason: SessionCloseReason,
) => void;

// Already-rendered text: for display, not for parsing.
export interface CliStatusReport {
  sections: { title: string; rows: { label?: string; value: string }[] }[];
}

export interface CliControlGetContextUsageResponse {
  total_tokens?: number;
  remaining_tokens?: number;
  [k: string]: unknown;
}

export interface CliUserMessage {
  type: 'user';
  message: { role: 'user'; content: unknown };
  parent_tool_use_id: string | null;
}

// Never inferred from the transcript: a resume of a session whose process died mid-turn starts idle.
export interface TurnState {
  status: 'idle' | 'running';
  since: string | null;
}

export const IDLE_TURN: TurnState = { status: 'idle', since: null };

export type SessionStatus =
  | 'starting'
  | 'started'
  | 'error'
  | 'stopped';

export interface SessionStartParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  model: string;
  permissionMode: string;
  resumeSessionId?: string;
  effort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  manualAccountOverride?: boolean;
  agent?: AgentKind;
}

export interface SessionsService {
  start(params: SessionStartParams): void | Promise<void>;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Record<string, unknown>[]): void;
  respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
    requestId?: string,
  ): boolean;
  respondElicitation(
    tabId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
    requestId?: string,
  ): Promise<void>;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
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
    turn: TurnState;
    launchPermissionMode: string | null;
    permissionMode: string | null;
  };
  getTurn(tabId: string): TurnState;
  isActive(tabId: string): boolean;
  listActiveTabIds(): string[];
  listActiveSessionIds(): string[];
  listSessionStatuses(): {
    tabId: string;
    sessionStatus: SessionStatus;
  }[];

  interrupt(tabId: string): Promise<void>;
  setModel(tabId: string, model?: string): Promise<string | null>;
  setTitle(tabId: string, title: string): Promise<boolean>;
  askSideQuestion(tabId: string, question: string): Promise<SideChatAskResult>;
  closeSideChat(tabId: string): void;
  getSideChat(tabId: string): SideChat;
  suggestTitle(tabId: string, description: string): Promise<string | null>;
  setPermissionMode(tabId: string, mode: PermissionMode): Promise<void>;
  setEffort(tabId: string, level: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void>;
  applyPermissions(
    tabId: string,
    permissions: { allow?: string[]; deny?: string[]; ask?: string[] },
  ): Promise<void>;
  getAccountInfo(tabId: string): Promise<AccountInfo | null>;
  getContextUsage(tabId: string): Promise<CliControlGetContextUsageResponse | null>;
  getTaskOutput(tabId: string, taskId: string): Promise<TaskOutputTail | null>;
  stopTask(tabId: string, taskId: string): Promise<void>;
  promptDraftActivity(tabId: string): Promise<void>;
  backgroundTask(tabId: string, toolUseId: string): Promise<boolean>;
  getCliStatus(tabId: string): Promise<CliStatusReport | null>;
  listPermissionRules(tabId: string): Promise<CliPermissionRulesState | null>;
  getSupportedCommands(tabId: string): Promise<SlashCommand[]>;
  getSupportedModels(tabId: string): Promise<ModelInfo[]>;
  getSupportedAgents(tabId: string): Promise<AgentInfo[]>;
  getMcpServerStatus(tabId: string): Promise<McpServerStatus[]>;
  mcpAuthenticate(tabId: string, serverName: string): Promise<McpAuthResult>;
  mcpReauthenticate(tabId: string, serverName: string): Promise<McpAuthResult>;
  mcpSetEnabled(tabId: string, serverName: string, enabled: boolean): Promise<void>;
  mcpReconnect(tabId: string, serverName: string): Promise<void>;
  mcpSubmitCallbackUrl(tabId: string, serverName: string, callbackUrl: string): Promise<void>;
  getPlugins(tabId: string, force?: boolean): Promise<import('./plugins').EnrichedPlugin[]>;
}

export type SendToRenderer = (channel: string, ...args: unknown[]) => void;


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

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: {
    type: 'addRules';
    rules: { toolName: string; ruleContent?: string }[];
    behavior: 'allow';
    destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
  }[];
  aborted?: boolean;
}

export interface PendingPermission {
  requestId: string;
  resolve: (decision: PermissionDecision) => void;
}

export interface SessionHandle {
  agent: AgentKind;
  engine: AgentEngine;
  initData: InitData | null;
  permissionMode: string;
  startParams: {
    projectPath: string;
    configDir: string;
    model?: string;
    permissionMode?: string;
  };
  sessionId: string | null;
  sessionStatus: SessionStatus;
  turn: TurnState;
  turnObserver?: (status: TurnState['status']) => void;
  activityObserver?: () => void;
  openBackgroundTasks?: () => number;
  // On the handle, not the listener, so a restart keeps it.
  modNotices?: ModNoticeTracker;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  permissionQueue: PendingPermission[];
  elicitationQueue: AgentElicitationRequest[];
  sideChat: SideChatStore;
  lastModel?: string;
  cliProcess?: { id: string; startedAt: string };
  projectPath: string;
  configDir: string;
  autoTitleAttempted: boolean;
}

export type PersistPermissionRuleFn = (params: {
  scope: 'user' | 'project' | 'local';
  behavior: 'allow' | 'deny';
  rule: string;
  configDir: string;
  projectPath: string;
}) => void;

export type { LoggingService };
