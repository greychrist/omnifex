// Sessions module — shared types
// Extracted from electron/services/sessions.ts (pure refactor)

import type { LoggingService } from '../logging';
import type { AgentElicitationRequest, AgentEngine, AgentKind, ElicitationAction, InitData } from '../agents/types';
import type { SideChatStore } from './side-chat';
import type { SideChat, SideChatAskResult } from '../../../src/lib/sideChat';

// ---------------------------------------------------------------------------
// CLI payload shapes (defined locally)
// ---------------------------------------------------------------------------
//
// The CLI emits these payloads over stream-json. We define the type names +
// structures here for callers that already use them. Marked `unknown` where
// the shape was deep — the runtime behavior doesn't depend on shape, only on
// field presence at the call site.

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

/**
 * Result of comparing an account's `expected_email` against the identity
 * actually authenticated in its config dir. `detected: null` means nobody is
 * logged in — treated as a mismatch, since that's the same failure class as
 * being logged in as the wrong person.
 */
export interface AccountMismatch {
  expected: string;
  detected: string | null;
  configDir: string;
  /** Which check produced this: the cheap pre-flight file read, or the
   *  authoritative `system:init` payload from the running CLI. */
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

export interface McpServerStatus {
  name: string;
  status?: string;
  [k: string]: unknown;
}

/**
 * Where a permission rule comes from, per the CLI's own taxonomy.
 *
 * OmniFex models only the three settings FILES (user/project/local). The rest
 * are invisible to `permissions-io.ts`, which is the gap `list_permission_rules`
 * closes. Note `flagSettings`: that is where our own `applyPermissions` push
 * lands (`apply_flag_settings`), as a source of its own rather than merging
 * into the file sources.
 *
 * Mirrors the CLI's `PermissionRuleSource` (permissionRuleLookup.ts). Kept as a
 * closed union deliberately — a new source appearing here is drift the next
 * changelog review should see, and `parsePermissionRulesState` drops rows it
 * cannot classify rather than widening silently.
 */
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

/**
 * The CLI's plain-language reading of a rule, split so hosts can bold the
 * rule-derived fragment the way the terminal does. `emphasis` is rule content
 * and may carry invisible characters by design — escape it at display.
 */
export interface CliPermissionRuleDescription {
  prefix: string;
  emphasis?: string;
  suffix?: string;
}

/** One permission rule as the live session holds it. */
export interface CliPermissionRule {
  behavior: 'allow' | 'deny' | 'ask';
  source: CliPermissionRuleSource;
  /**
   * The stored rule string VERBATIM. Two spellings that parse identically each
   * get their own entry, and it can carry control characters — escape at
   * display, never match on it without normalizing.
   */
  rule: string;
  description?: CliPermissionRuleDescription;
  /**
   * Where the rule lives: `persistent` (a settings file), `session` (in memory
   * for this session only), or `readonly` (policy/flag/command — what the
   * terminal's /permissions treats as uneditable). Informational: this request
   * never changes rules.
   */
  editability: 'persistent' | 'session' | 'readonly';
  /** True when managed settings pin policy-only mode and this rule is ignored. */
  notInEffect?: boolean;
}

/** One additional working directory in the session's permission scope. */
export interface CliWorkspaceDirectory {
  path: string;
  source: string;
}

/** The session's live permission state, as `list_permission_rules` reports it. */
export interface CliPermissionRulesState {
  rules: CliPermissionRule[];
  workspaceDirectories: CliWorkspaceDirectory[];
  originalCwd: string;
  /** True when managed settings pin `allowManagedPermissionRulesOnly`. */
  managedOnly: boolean;
  /** Settings files skipped by the merge — their rules are NOT in the session. */
  errors?: unknown[];
}

/**
 * Why a session's handle went away. `'shutdown'` is every close `stopAll()`
 * makes — the process is exiting, so work started from the close hook dies
 * with it.
 */
export type SessionCloseReason = 'closed' | 'shutdown';

export type SessionClosedHook = (
  sessionId: string,
  projectPath: string,
  configDir: string,
  reason: SessionCloseReason,
) => void;

/**
 * The CLI's `/status` screen as data (`get_status`, CLI >= 2.1.280). Every
 * value is already rendered text — for display, not for parsing.
 */
export interface CliStatusReport {
  sections: Array<{ title: string; rows: Array<{ label?: string; value: string }> }>;
}

export interface CliControlGetContextUsageResponse {
  total_tokens?: number;
  remaining_tokens?: number;
  [k: string]: unknown;
}

/**
 * CliUserMessage is a user-input payload shape. The CLI engine accepts text via
 * `engine.send(text)` and structured content via `engine.sendStructured(content)`,
 * so we no longer need this shape inside the sessions module — kept as
 * an opaque alias for the brief window where callers haven't migrated.
 */
export interface CliUserMessage {
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
 *  - starting: CLI spawned, awaiting the CLI's system:init
 *  - started:  CLI answered; session has a GUID; ready for conversation
 *  - error:    stream errored, kept alive for retry
 *  - stopped:  cleanly closed
 *
 * ConversationStatus is now derived by the renderer from JSONL content +
 * task/subagent stores (see src/lib/sessionDerivedState.ts). Main process
 * owns sessionStatus only — the "is the CLI process up?" axis.
 */
/**
 * The turn axis, owned by the session. `running` from the moment a prompt is
 * handed to the CLI until its `result` row lands or the process goes away.
 * Never inferred from the transcript: a `--resume` of a session whose process
 * died mid-turn starts `idle`, because the new process is not working on
 * anything. See docs/session-lifecycle.md.
 */
export interface TurnState {
  status: 'idle' | 'running';
  /** ISO timestamp the running turn started; null while idle. */
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
  /** webContents.id of the window that started this session — used to route tab-scoped events back to that window only. */
  ownerWebContentsId?: number;
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
   * down the CLI session. Returns true if a session was found and re-bound,
   * false if no session exists for that tabId. Used when the renderer reloads
   * (Cmd+R) and needs to re-claim its in-flight sessions.
   */
  rebind(tabId: string, ownerWebContentsId: number): boolean;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Record<string, unknown>[]): void;
  /**
   * Answer a pending permission. `requestId` addresses a specific entry (the
   * Remote daemon always passes one); omitted, the head of the queue is
   * answered — the desktop behaviour. Returns false when nothing matched.
   */
  respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
    requestId?: string,
  ): boolean;
  /**
   * Answer the MCP elicitation on screen. `requestId` names the request the
   * dialog was showing; a stale one (withdrawn by the CLI meanwhile) is
   * dropped rather than applied to the next in line.
   */
  respondElicitation(
    tabId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
    requestId?: string,
  ): Promise<void>;
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
    turn: TurnState;
  };
  /** The turn axis for a tab; idle for a tab the service does not know. */
  getTurn(tabId: string): TurnState;
  isActive(tabId: string): boolean;
  /** Return all tab IDs that currently have a registered session handle. */
  listActiveTabIds(): string[];
  /** Session UUIDs of every open session. The Brain's live-source guard
   *  reads this to refuse indexing a transcript that is still growing. */
  listActiveSessionIds(): string[];
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
  /**
   * Rename the session via the CLI's own `rename_session` control request.
   * Resolves false when the rename could not be sent (no live engine, blank
   * title) so the caller can say so rather than looking like it worked.
   */
  setTitle(tabId: string, title: string): Promise<boolean>;
  /**
   * Ask a side question (the CLI's `/btw`). Resolves once the exchange is
   * pending; the answer arrives on `session-side-chat:<tabId>`.
   */
  askSideQuestion(tabId: string, question: string): Promise<SideChatAskResult>;
  /** Discard the side chat, cancelling a pending question. */
  closeSideChat(tabId: string): void;
  /** The current side chat — empty for an unknown tab. */
  getSideChat(tabId: string): SideChat;
  /** Ask the CLI for a name from `description`; nothing is persisted. Null when it had none. */
  suggestTitle(tabId: string, description: string): Promise<string | null>;
  /** Switch the permission mode mid-session. */
  setPermissionMode(tabId: string, mode: PermissionMode): Promise<void>;
  /** Change effort level mid-session. 'auto' and null clear the override and revert to the model's default. */
  setEffort(tabId: string, level: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void>;
  /**
   * Push permission rule lists into the live CLI session. Send the full
   * effective allow/deny list — applyFlagSettings shallow-replaces the
   * `permissions` key, so deltas would lose previously-pushed rules.
   */
  applyPermissions(
    tabId: string,
    permissions: { allow?: string[]; deny?: string[]; ask?: string[] },
  ): Promise<void>;
  /** Change thinking mode mid-session. */
  /** Get the CLI-reported authenticated account for an active tab. Null if the tab isn't running. */
  getAccountInfo(tabId: string): Promise<AccountInfo | null>;
  /** Get the current context-window usage breakdown. Null if the tab isn't running. */
  getContextUsage(tabId: string): Promise<CliControlGetContextUsageResponse | null>;
  /** The CLI's `/status` rows for a live session; null when there is no live
   *  engine or the CLI predates `get_status`. */
  getCliStatus(tabId: string): Promise<CliStatusReport | null>;
  listPermissionRules(tabId: string): Promise<CliPermissionRulesState | null>;
  /** Get the list of slash commands the CLI knows about for this session. Empty if no tab. */
  getSupportedCommands(tabId: string): Promise<SlashCommand[]>;
  /** Get the list of models the CLI knows about for this session. Empty if no tab. */
  getSupportedModels(tabId: string): Promise<ModelInfo[]>;
  /** Get the list of subagents the CLI knows about for this session. Empty if no tab. */
  getSupportedAgents(tabId: string): Promise<AgentInfo[]>;
  /** Get live MCP server status for an active session. Empty if no tab. */
  getMcpServerStatus(tabId: string): Promise<McpServerStatus[]>;
  /** Get loaded plugins for an active session, enriched with manifest data. */
  getPlugins(tabId: string, force?: boolean): Promise<import('./plugins').EnrichedPlugin[]>;
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
 * the CLI streams. Wired in main.ts; tests typically leave it undefined.
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
  /** Set when the CLI's `AbortSignal` fired while the request was queued —
   *  i.e. the tool use was cancelled before the user responded. Treated as a
   *  deny on the way back to the CLI, but distinguished from a user-driven
   *  deny so logging and any future CLI contract that wants a richer signal
   *  has a hook. */
  aborted?: boolean;
}

export interface PendingPermission {
  requestId: string;
  resolve: (decision: PermissionDecision) => void;
}

export interface SessionHandle {
  /**
   * Which agent powers this session. Pinned at handle construction so
   * the restart path knows which factory to call without re-resolving
   * from start-params.
   */
  agent: AgentKind;
  /** Drives the live session over stream-json. */
  engine: AgentEngine;
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
  /** Turn axis. See docs/session-lifecycle.md. */
  turn: TurnState;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  /** Queue of permission requests waiting for user response */
  permissionQueue: PendingPermission[];
  /**
   * MCP elicitations awaiting the user, oldest first. The head is the one on
   * screen. See sessions/elicitations.ts.
   */
  elicitationQueue: AgentElicitationRequest[];
  /** The side chat thread (the CLI's `/btw`). Not a state axis — see side-chat.ts. */
  sideChat: SideChatStore;
  /**
   * Model of the latest real assistant message. Sessions switch models
   * mid-way; this is the one that answered most recently, and so the one a
   * side question's fork runs on.
   */
  lastModel?: string;
  /**
   * The CLI process running this session now: set by `beginCliProcess` on
   * every engine start, so the CLI's running totals can be tied to a process
   * and a baseline. See sessions/cli-usage.ts.
   */
  cliProcess?: { id: string; startedAt: string };
  projectPath: string;
  configDir: string;
  /**
   * Auto-naming latch: true once this session has asked the CLI for a name,
   * or was resumed (a resumed conversation names itself by hand — see
   * `auto-title.ts`). Fires at most once per handle.
   */
  autoTitleAttempted: boolean;
}

/**
 * Optional callback the sessions service calls to persist an accepted
 * permission rule to disk. Main.ts wires this to permissions-io's
 * updatePermission; tests pass a vi.fn(). Omitted / null → rules are only
 * handed to the CLI (in-memory for the session).
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
