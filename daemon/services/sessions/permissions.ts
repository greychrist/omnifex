import os from 'node:os';
import path from 'node:path';
import type { LoggingService } from '../logging';
import { formatFilePathForRule } from '../../../src/lib/rulePaths';
import { canonicalizeRule, type ParsedRule } from '../../../src/lib/permissionCardLogic';
import type {
  SessionHandle,
  PermissionDecision,
  PendingPermission,
  SendToRenderer,
  PersistPermissionRuleFn,
} from './types';
import type { AgentPermissionRequest } from '../agents/types';

function currentPermissionMode(handle: SessionHandle): string {
  return handle.permissionMode || 'default';
}

// Read isn't here: the CLI never routes read-only tools through the prompt tool.
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface EscalationSignals {
  blocked_path?: string;
  decision_reason_type?: string;
  // No stored grant or automatic approval may answer this ask.
  requires_user_interaction?: boolean;
  decision_reason_code?: string;
  // The auto-mode classifier raised this ask.
  auto_modes_check_raised?: boolean;
}

function autoDecisionForMode(
  mode: string,
  toolName: string,
  payload: EscalationSignals = {},
  agent: 'claude' | 'codex' = 'claude',
): 'allow' | 'deny' | null {
  switch (mode) {
    case 'bypassPermissions':
      return agent === 'codex' ? 'allow' : null;
    case 'acceptEdits':
      return FILE_EDIT_TOOLS.has(toolName) && !isEscalatedEdit(payload) ? 'allow' : null;
    case 'dontAsk':
      return 'deny';
    default:
      return null;
  }
}

// An ask the CLI makes even under `--dangerously-skip-permissions`.
function isSafetyCheck(payload: { decision_reason_type?: string }): boolean {
  return payload.decision_reason_type === 'safetyCheck';
}

// An edit the CLI still sends in acceptEdits is one it refused to auto-accept; allowing it overrides the CLI with nobody looking.
function isEscalatedEdit(payload: EscalationSignals): boolean {
  return (
    payload.requires_user_interaction === true ||
    !!payload.blocked_path ||
    payload.decision_reason_type === 'workingDir' ||
    isSafetyCheck(payload) ||
    isClassifierRaised(payload)
  );
}

// Mirrors the CLI's own `isClassifierRaised`.
function isClassifierRaised(payload: EscalationSignals): boolean {
  return (
    payload.decision_reason_type === 'classifier' ||
    payload.decision_reason_code === 'classifier_transcript_too_long' ||
    payload.auto_modes_check_raised === true
  );
}

// No `Edit(...)` rule stops a symlink-escape ask; only adding the directory does.
function directoryGrantFor(payload: {
  blocked_path?: string;
  permission_suggestions?: unknown[];
}): string[] | null {
  if (!payload.blocked_path) return null;
  const fromCli = payload.permission_suggestions?.find((s) => {
    const entry = s as { type?: unknown; directories?: unknown } | null | undefined;
    return entry?.type === 'addDirectories' && Array.isArray(entry.directories) && entry.directories.length > 0;
  }) as { directories: unknown[] } | undefined;
  const dirs = fromCli?.directories.filter((d): d is string => typeof d === 'string' && d.length > 0);
  return dirs && dirs.length > 0 ? dirs : [path.dirname(payload.blocked_path)];
}

const NOTIF_BODY_CAP = 140;

export function truncate(s: string): string {
  const t = s.trim();
  return t.length > NOTIF_BODY_CAP ? t.slice(0, NOTIF_BODY_CAP - 1) + '…' : t;
}

function summarizeRequest(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  hints?: { title?: string; displayName?: string },
): string {
  const hint = (hints?.title || hints?.displayName || '').trim();
  if (hint) return truncate(hint);

  const input: Record<string, unknown> = toolInput ?? {};
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return truncate(`$ ${input.command}`);
  }
  if (
    (toolName === 'Write' ||
      toolName === 'Edit' ||
      toolName === 'MultiEdit' ||
      toolName === 'Read' ||
      toolName === 'NotebookEdit') &&
    typeof input.file_path === 'string'
  ) {
    return truncate(`${toolName} ${input.file_path}`);
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return truncate(`WebFetch ${input.url}`);
  }
  if (
    (toolName === 'Glob' || toolName === 'Grep') &&
    typeof input.pattern === 'string'
  ) {
    return truncate(`${toolName} ${input.pattern}`);
  }
  return toolName;
}

export function permissionNotificationContent(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  hints?: { title?: string; displayName?: string },
): { body: string; subtitle: string } {
  if (toolName === 'AskUserQuestion') {
    const questions = toolInput?.questions;
    const first =
      Array.isArray(questions) && questions.length > 0
        ? (questions[0] as { question?: unknown } | null | undefined)
        : undefined;
    const text = typeof first?.question === 'string' ? first.question.trim() : '';
    return {
      subtitle: 'Answer Needed:',
      body: text ? truncate(text) : 'Awaiting your response',
    };
  }
  return {
    subtitle: 'Permission Request:',
    body: summarizeRequest(toolName, toolInput, hints),
  };
}

interface PermissionSuggestion {
  type?: string;
  destination?: string;
  behavior?: string;
  rules?: unknown;
  [key: string]: unknown;
}

function scopeForDestination(
  dest: string | undefined,
): 'user' | 'project' | 'local' | null {
  switch (dest) {
    case 'userSettings':
      return 'user';
    case 'projectSettings':
      return 'project';
    case 'localSettings':
      return 'local';
    case 'session':
    case undefined:
      return null;
    default:
      return null;
  }
}

function formatRule(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
}

// Only the `session` destination updates the live process's rules; a disk-only rule re-prompts on the next matching tool_use.
export function augmentPermissionsWithSession(
  updates: PermissionSuggestion[] | undefined,
): PermissionSuggestion[] | undefined {
  if (!updates) return updates;
  const out: PermissionSuggestion[] = [];
  for (const u of updates) {
    out.push(u);
    const update = u as PermissionSuggestion | null | undefined;
    // Rules only: the CLI applies `addDirectories` live at any destination.
    if (update?.type === 'addRules' && update.destination !== 'session') {
      out.push({ ...u, destination: 'session' });
    }
  }
  return out;
}

// The CLI suggests no path rule for file tools, so this is the only source: always `Edit(path)`, the only form file checks match.
// Invents nothing for Bash: the CLI is the only judge of a Bash rule.
export function buildDefaultRule(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string,
  opts: { folder?: boolean } = {},
): ParsedRule | null {
  if (toolName === 'Bash') return null;
  if (
    toolName === 'Write' ||
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'Read' ||
    toolName === 'NotebookEdit'
  ) {
    const fp = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
    if (!fp) return { toolName };
    // Grant the folder, not the file: a per-file rule made the next file in that folder ask again.
    if (opts.folder && path.isAbsolute(fp)) {
      const dir = formatFilePathForRule(path.dirname(fp), projectPath, os.homedir());
      return canonicalizeRule({ toolName, ruleContent: `${dir.replace(/\/+$/, '')}/**` });
    }
    return canonicalizeRule({
      toolName,
      ruleContent: formatFilePathForRule(fp, projectPath, os.homedir()),
    });
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : undefined;
    return pattern ? { toolName, ruleContent: pattern } : { toolName };
  }
  if (toolName === 'WebFetch' && typeof toolInput.url === 'string') {
    try {
      const u = new URL(toolInput.url);
      return { toolName, ruleContent: `domain:${u.hostname}` };
    } catch {
      return { toolName };
    }
  }
  return { toolName };
}

// Prepend, never replace: keep the CLI's `setMode` offer; the card reads the first entry that carries rules.
function hasRuleSuggestion(suggestions: unknown[] | undefined): boolean {
  return !!suggestions?.some((s) => {
    const entry = s as { type?: unknown; rules?: unknown } | null | undefined;
    return (
      entry?.type === 'addRules' &&
      Array.isArray(entry.rules) &&
      (entry.rules as ({ toolName?: unknown } | null | undefined)[]).some(
        (r) => r && typeof r.toolName === 'string' && r.toolName.trim(),
      )
    );
  });
}

export function withDefaultRuleSuggestion(
  suggestions: PermissionSuggestion[] | undefined,
  defaultRule: ParsedRule | null,
): PermissionSuggestion[] | undefined {
  if (hasRuleSuggestion(suggestions) || !defaultRule) return suggestions;
  return [
    {
      type: 'addRules',
      rules: [defaultRule],
      behavior: 'allow',
      destination: 'localSettings',
    },
    ...(suggestions ?? []),
  ];
}

export function createPermissionRequestHandler(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  logging: LoggingService | null = null,
): (req: AgentPermissionRequest) => void {
  const logEntry = (entry: {
    level: 'info' | 'warn' | 'error';
    message: string;
    metadata: Record<string, unknown>;
  }) => {
    if (!logging) return;
    try {
      logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: entry.level,
          source: 'claude-sdk',
          category: 'permission',
          message: entry.message,
          metadata: JSON.stringify(entry.metadata),
        },
      ]);
    } catch (err) {
      console.error('[sessions] permission logging failed:', err);
    }
  };

  function handleCodexApprovalRequest(req: AgentPermissionRequest): void {
    const requestId = req.requestId;
    const permissionMode = currentPermissionMode(handle);

    const autoDecision = autoDecisionForMode(permissionMode, `codex.${req.kind}`, {}, 'codex');
    if (autoDecision) {
      logEntry({
        level: 'info',
        message: `permission decision: ${autoDecision} codex.${req.kind} (${permissionMode})`,
        metadata: {
          event: 'permission.decision',
          agent: 'codex',
          kind: req.kind,
          behavior: autoDecision,
          persisted: false,
          permission_mode: permissionMode,
          auto_allowed: autoDecision === 'allow',
        },
      });
      handle.engine?.respondPermission(requestId, autoDecision)
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
      return;
    }

    const summary = req.summary || (req.kind === 'patch' ? 'Apply patch' : 'Run command');

    const payload = {
      type: 'permission_request',
      request_id: requestId,
      kind: req.kind,
      agent: 'codex',
      summary,
      codex_payload: req.payload,
      // Stubbed so the renderer's normalizer doesn't crash on `undefined`.
      tool_name: req.kind === 'patch' ? 'apply_patch' : 'exec_command',
      tool_input: {},
      permission_suggestions: [],
    };

    logEntry({
      level: 'info',
      message: `permission request: codex.${req.kind}`,
      metadata: {
        event: 'permission.request',
        agent: 'codex',
        kind: req.kind,
        request_id: requestId,
        summary,
      },
    });

    const entry: PendingPermission & {
      payload: QueuedPermissionPayload;
      toolInput: Record<string, unknown>;
    } = {
      requestId,
      resolve: () => { /* engine flow uses engine.respondPermission directly */ },
      payload,
      toolInput: {},
    };
    handle.permissionQueue.push(entry);

    if (handle.permissionQueue.length === 1) {
      sendToRenderer(`agent-output:${tabId}`, payload);

      const projectName = path.basename(handle.projectPath) || 'OmniFex';
      const title = `OmniFex — ${projectName}`;
      const body = truncate(summary);
      sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false, subtitle: 'Permission Request:' });
    }
  }

  return (req: AgentPermissionRequest): void => {
    if (req.kind === 'patch' || req.kind === 'exec') {
      handleCodexApprovalRequest(req);
      return;
    }

    const rawPayload = req.payload as {
      tool_name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      permission_suggestions?: PermissionSuggestion[];
      blocked_path?: string;
      decision_reason?: string;
      decision_reason_type?: string;
      title?: string;
      display_name?: string;
      description?: string;
      suppress_always_allow_rule?: boolean;
      requires_user_interaction?: boolean;
    };
    const toolName = rawPayload.tool_name ?? 'unknown';
    const toolInput = rawPayload.input ?? {};
    const toolUseID = rawPayload.tool_use_id ?? '';
    const requestId = req.requestId;
    const permissionMode = currentPermissionMode(handle);

    const autoDecision = autoDecisionForMode(permissionMode, toolName, rawPayload);
    if (autoDecision) {
      logEntry({
        level: 'info',
        message: `permission decision: ${autoDecision} ${toolName} (${permissionMode})`,
        metadata: {
          event: 'permission.decision',
          tool_name: toolName,
          tool_use_id: toolUseID,
          behavior: autoDecision,
          persisted: false,
          permission_mode: permissionMode,
          auto_allowed: autoDecision === 'allow',
        },
      });
      const body: Record<string, unknown> =
        autoDecision === 'allow'
          ? { updatedInput: toolInput }
          : { message: `Denied by permission mode: ${permissionMode}` };
      handle.engine?.respondPermission(requestId, autoDecision, body)
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
      return;
    }

    // Withhold our fallback rule too: for an MCP tool it is the bare whole-tool allow this flag prevents. Keep the CLI's suggestions.
    const cliSuppressed = rawPayload.suppress_always_allow_rule === true;
    const suggestions = cliSuppressed
      ? rawPayload.permission_suggestions
      : withDefaultRuleSuggestion(
          rawPayload.permission_suggestions,
          buildDefaultRule(toolName, toolInput, handle.projectPath, {
            folder: rawPayload.decision_reason_type === 'workingDir',
          }),
        );
    const directoryGrant = cliSuppressed ? null : directoryGrantFor(rawPayload);
    // No CLI rule for Bash means none would allow it again: offer allow-once, never a bare `Bash` rule.
    const noBashRule =
      toolName === 'Bash' && !directoryGrant && !hasRuleSuggestion(suggestions);
    const suppressAlwaysAllowRule = cliSuppressed || noBashRule;

    const payload = {
      type: 'permission_request',
      request_id: requestId,
      tool_name: toolName,
      tool_input: toolInput,
      title: rawPayload.title,
      display_name: rawPayload.display_name,
      description: rawPayload.description,
      // The CLI can send one sentence as both; the card would draw it twice.
      decision_reason: rawPayload.decision_reason === rawPayload.description ? undefined : rawPayload.decision_reason,
      blocked_path: rawPayload.blocked_path,
      permission_suggestions: suggestions,
      directory_grant: directoryGrant ?? undefined,
      // Omitted rather than `false` so the wire stays the CLI's shape.
      suppress_always_allow_rule: suppressAlwaysAllowRule || undefined,
    };

    logEntry({
      level: 'info',
      message: `permission request: ${toolName}`,
      metadata: {
        event: 'permission.request',
        tool_name: toolName,
        tool_use_id: toolUseID,
        tool_input: toolInput,
        request_id: requestId,
        suggestions,
      },
    });

    const entry: PendingPermission & {
      payload: QueuedPermissionPayload;
      toolInput: Record<string, unknown>;
    } = {
      requestId,
      resolve: () => {
        /* not used in the engine flow — kept for type compat with PendingPermission */
      },
      payload,
      toolInput,
    };
    handle.permissionQueue.push(entry);

    if (handle.permissionQueue.length === 1) {
      sendToRenderer(`agent-output:${tabId}`, payload);

      const projectName = path.basename(handle.projectPath) || 'OmniFex';
      const title = `OmniFex — ${projectName}`;
      const { body, subtitle } = permissionNotificationContent(toolName, toolInput, {
        title: rawPayload.title,
        displayName: rawPayload.display_name,
      });
      sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false, subtitle });
    }
  };
}

interface QueuedPermissionPayload {
  kind?: 'tool' | 'patch' | 'exec';
  summary?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  title?: string;
  display_name?: string;
}

type QueuedPermission = PendingPermission & {
  toolInput?: Record<string, unknown>;
  payload?: QueuedPermissionPayload;
};

// Sent only when advertised: an older CLI on a strict host refuses the whole answer.
export const UNANSWERED_CAPABILITY = 'ask_user_question_unanswered_v1';

type Unanswered = 'dismissed' | 'replied_in_chat';

// The model never sees `unanswered`; it reads these.
const UNANSWERED_TEXT: Record<Unanswered, string> = {
  dismissed: 'The user dismissed this question without answering.',
  replied_in_chat: 'The user did not answer this question and replied in chat instead; their message follows.',
};

function advertisesUnanswered(handle: SessionHandle): boolean {
  const caps = handle.engine?.getInitData()?.capabilities;
  return Array.isArray(caps) && caps.includes(UNANSWERED_CAPABILITY);
}

function unansweredQuestionInput(
  toolInput: Record<string, unknown> | undefined,
  how: Unanswered,
): Record<string, unknown> {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const answers: Record<string, string> = {};
  const annotations: Record<string, { unanswered: Unanswered }> = {};
  for (const q of questions) {
    const text = (q as { question?: unknown } | null)?.question;
    if (typeof text !== 'string') continue;
    answers[text] = UNANSWERED_TEXT[how];
    annotations[text] = { unanswered: how };
  }
  return { questions: toolInput?.questions ?? [], answers, annotations };
}

export function answerPendingQuestionInChat(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
): boolean {
  const head = handle.permissionQueue[0] as QueuedPermission | undefined;
  if (!head || head.payload?.tool_name !== 'AskUserQuestion' || !advertisesUnanswered(handle)) return false;
  respondPermission(
    handle,
    tabId,
    sendToRenderer,
    'allow',
    unansweredQuestionInput(head.toolInput, 'replied_in_chat'),
    undefined,
    null,
    head.requestId,
  );
  if (handle.permissionQueue.length === 0) {
    sendToRenderer(`agent-output:${tabId}`, { type: 'permission_withdrawn', request_id: head.requestId });
  }
  return true;
}

export function respondPermission(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  behavior: 'allow' | 'deny',
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: PermissionDecision['updatedPermissions'],
  persistPermissionRule?: PersistPermissionRuleFn | null,
  requestId?: string,
): boolean {
  if (handle.permissionQueue.length === 0) return false;

  // Address by id: with two clients, answering the head could resolve a request the clicker never saw.
  const index = requestId === undefined
    ? 0
    : handle.permissionQueue.findIndex((p) => p.requestId === requestId);
  if (index < 0) return false;

  const augmented = behavior === 'allow'
    ? augmentPermissionsWithSession(updatedPermissions)
    : updatedPermissions;

  const current = handle.permissionQueue.splice(index, 1)[0] as QueuedPermission;

  // No body for Codex: a Claude-shaped body would spread into its JSON-RPC result.
  const isCodexApproval =
    current.payload?.kind === 'patch' || current.payload?.kind === 'exec';

  if (behavior === 'deny' && !isCodexApproval && current.payload?.tool_name === 'AskUserQuestion'
      && advertisesUnanswered(handle)) {
    behavior = 'allow';
    updatedInput = unansweredQuestionInput(current.toolInput, 'dismissed');
  }

  if (handle.engine) {
    if (isCodexApproval) {
      handle.engine.respondPermission(current.requestId, behavior)
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
    } else {
      const permissionResultBody: Record<string, unknown> = { behavior };
      if (behavior === 'allow') {
        // Required for allow; `{}` breaks the CLI.
        permissionResultBody.updatedInput = updatedInput ?? current.toolInput ?? {};
        if (augmented && augmented.length > 0) {
          permissionResultBody.updatedPermissions = augmented;
        }
      } else {
        permissionResultBody.message = 'User denied permission';
      }
      handle.engine.respondPermission(current.requestId, behavior, permissionResultBody)
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
    }
  }

  // The original updates, not the augmented array, so the session twin is never written to disk.
  if (behavior === 'allow' && persistPermissionRule && updatedPermissions) {
    for (const suggestion of updatedPermissions) {
      const loose = suggestion as {
        destination?: string;
        rules?: ({ toolName?: unknown; ruleContent?: string } | null | undefined)[];
        behavior?: string;
      };
      const scope = scopeForDestination(loose.destination);
      if (!scope) continue;
      const rules = loose.rules ?? [];
      const suggBehavior = loose.behavior === 'deny' ? 'deny' : 'allow';
      for (const r of rules) {
        if (!r || typeof r.toolName !== 'string' || !r.toolName.trim()) continue;
        try {
          persistPermissionRule({
            scope,
            behavior: suggBehavior,
            rule: formatRule({ toolName: r.toolName, ruleContent: r.ruleContent }),
            configDir: handle.configDir,
            projectPath: handle.projectPath,
          });
        } catch (e) {
          console.error('[sessions] persistPermissionRule failed:', e);
        }
      }
    }
  }

  // Only when the answered one was the head; otherwise the renderer is already showing the head.
  if (index === 0) showNextPermission(handle, tabId, sendToRenderer);
  return true;
}

function showNextPermission(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
): void {
  if (handle.permissionQueue.length === 0) return;
  const next = handle.permissionQueue[0];
  const nextPayload = (next as PendingPermission & { payload: QueuedPermissionPayload }).payload;
  sendToRenderer(`agent-output:${tabId}`, nextPayload);

  const projectName = path.basename(handle.projectPath) || 'OmniFex';
  const title = `OmniFex — ${projectName}`;
  let body: string;
  let subtitle: string;
  if (nextPayload.kind === 'patch' || nextPayload.kind === 'exec') {
    body = typeof nextPayload.summary === 'string' && nextPayload.summary
      ? truncate(nextPayload.summary)
      : nextPayload.kind === 'patch' ? 'Apply patch' : 'Run command';
    subtitle = 'Permission Request:';
  } else {
    ({ body, subtitle } = permissionNotificationContent(
      nextPayload.tool_name,
      nextPayload.tool_input,
      { title: nextPayload.title, displayName: nextPayload.display_name },
    ));
  }
  sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false, subtitle });
}

// Withdrawing the head must show the next or drop the card: a stale head hid every request behind it.
export function createPermissionCancelHandler(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
): (requestId: string) => void {
  return (requestId) => {
    const index = handle.permissionQueue.findIndex((p) => p.requestId === requestId);
    if (index < 0) return;
    handle.permissionQueue.splice(index, 1);
    if (index !== 0) return;
    if (handle.permissionQueue.length > 0) {
      showNextPermission(handle, tabId, sendToRenderer);
    } else {
      sendToRenderer(`agent-output:${tabId}`, { type: 'permission_withdrawn', request_id: requestId });
    }
  };
}
