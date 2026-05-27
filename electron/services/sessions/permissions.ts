// Sessions module — permission handling
// Extracted from electron/services/sessions.ts (pure refactor)

import path from 'node:path';
import type { LoggingService } from '../logging';
import { formatFilePathForRule } from './rule-paths';
import type {
  SessionHandle,
  PermissionDecision,
  PendingPermission,
  SendToRenderer,
  NotificationHooks,
  PersistPermissionRuleFn,
} from './types';
import type { AgentPermissionRequest } from '../agents/types';
import { setStatus } from './status';

function currentPermissionMode(handle: SessionHandle): string {
  return handle.permissionMode || 'default';
}

const NOTIF_BODY_CAP = 140;

function truncate(s: string): string {
  const t = s.trim();
  return t.length > NOTIF_BODY_CAP ? t.slice(0, NOTIF_BODY_CAP - 1) + '…' : t;
}

function summarizeRequest(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  hints?: { title?: string; displayName?: string },
): string {
  // Prefer the SDK-provided title/displayName when present — those already
  // read like a one-liner summary (e.g. "Run rm -rf /").
  const hint = (hints?.title || hints?.displayName || '').trim();
  if (hint) return truncate(hint);

  const input = toolInput ?? {};
  if (toolName === 'Bash' && typeof (input as any).command === 'string') {
    return truncate(`$ ${(input as any).command}`);
  }
  if (
    (toolName === 'Write' ||
      toolName === 'Edit' ||
      toolName === 'MultiEdit' ||
      toolName === 'Read' ||
      toolName === 'NotebookEdit') &&
    typeof (input as any).file_path === 'string'
  ) {
    return truncate(`${toolName} ${(input as any).file_path}`);
  }
  if (toolName === 'WebFetch' && typeof (input as any).url === 'string') {
    return truncate(`WebFetch ${(input as any).url}`);
  }
  if (
    (toolName === 'Glob' || toolName === 'Grep') &&
    typeof (input as any).pattern === 'string'
  ) {
    return truncate(`${toolName} ${(input as any).pattern}`);
  }
  return toolName;
}

/**
 * Notification subtitle + body for a permission prompt. AskUserQuestion is
 * the SDK's built-in question tool — it rides the permission channel but the
 * agent is *asking the user* something, not requesting a tool. We surface
 * that distinction via the subtitle ("Answer Needed:" vs "Permission
 * Request:") and put a summary of the actual request in the body.
 */
export function permissionNotificationContent(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  hints?: { title?: string; displayName?: string },
): { body: string; subtitle: string } {
  if (toolName === 'AskUserQuestion') {
    const questions = (toolInput as any)?.questions;
    const first =
      Array.isArray(questions) && questions.length > 0 ? questions[0] : undefined;
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

/** Map the SDK's destination string to our settings-file scope. */
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

/** Stringify a rule entry as it appears in .claude/settings.*.json. */
function formatRule(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
}

/**
 * Mirror every persistent addRules update with a session-destination twin so
 * the running query's in-memory rule set is updated *immediately* alongside
 * the on-disk write.
 *
 * Why: the SDK's PermissionUpdate destinations (`userSettings`,
 * `projectSettings`, `localSettings`, `session`) are *persistence targets*,
 * not "apply now" flags — only `'session'` says "fold this into the live
 * query's rule cache." If we send only `localSettings`, the rule lands on
 * disk but the same SDK process never re-reads it, and the very next
 * matching tool_use re-prompts. Sending both gives us live semantics
 * (matching tool_uses short-circuit `canUseTool` for the rest of the
 * session) AND on-disk persistence (next session boot loads it again).
 *
 * Pure function, returns a new array; never mutates input.
 */
export function augmentPermissionsWithSession(
  updates: any[] | undefined,
): any[] | undefined {
  if (!updates) return updates;
  const out: any[] = [];
  for (const u of updates) {
    out.push(u);
    if (u?.type === 'addRules' && u.destination !== 'session') {
      out.push({ ...u, destination: 'session' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// handleEnginePermissionRequest — engine.onPermissionRequest subscriber
//
// The SDK era had createCanUseTool: an async callback the SDK awaited for
// each tool use. We resolved a promise via respondPermission, the callback
// returned a PermissionResult, the SDK shipped it back to the CLI.
//
// In the CLI-engine era the flow inverts: the CLI sends a
// control_request:can_use_tool, the engine surfaces it via
// onPermissionRequest, and we (1) enqueue + render exactly the same UI
// payload as before so the renderer is unchanged, then (2) on user click,
// call engine.respondPermission directly with the decision body.
// ---------------------------------------------------------------------------

export function createPermissionRequestHandler(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
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

  // Helper: build a sensible default rule from the tool name and input.
  // Used when the CLI gives us no suggestions OR an empty rules array
  // (which would render as a blank row in the dialog).
  function buildDefaultRule(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): { toolName: string; ruleContent?: string } | null {
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      const cmd = (toolInput.command).trim();
      const base = cmd.split(/[\s;|&]/)[0];
      return { toolName, ruleContent: base ? `${base}:*` : cmd };
    }
    if (
      toolName === 'Write' ||
      toolName === 'Edit' ||
      toolName === 'MultiEdit' ||
      toolName === 'Read' ||
      toolName === 'NotebookEdit'
    ) {
      const fp = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
      if (!fp) return { toolName };
      return { toolName, ruleContent: formatFilePathForRule(fp, handle.projectPath) };
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

  /**
   * Forward a Codex approval (patch / exec) to the renderer. Codex requests
   * carry a structured `payload` that the renderer renders via the dedicated
   * Codex preview components — the dialog does not surface a Claude-style
   * rule editor here because Codex's protocol has no per-rule persistence.
   *
   * Allow / Deny still routes through `respondPermission` below; the dispatch
   * just emits `behavior: 'allow' | 'deny'` and the Codex engine maps that
   * to `decision: 'allow' | 'deny'` on the JSON-RPC respondToServer envelope.
   */
  function handleCodexApprovalRequest(req: AgentPermissionRequest): void {
    const requestId = req.requestId;
    const permissionMode = currentPermissionMode(handle);

    if (permissionMode === 'bypassPermissions') {
      logEntry({
        level: 'info',
        message: `permission decision: allow codex.${req.kind} (${permissionMode})`,
        metadata: {
          event: 'permission.decision',
          agent: 'codex',
          kind: req.kind,
          behavior: 'allow',
          persisted: false,
          permission_mode: permissionMode,
          auto_allowed: true,
        },
      });
      handle.engine?.respondPermission(requestId, 'allow')
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
      return;
    }

    const summary = req.summary || (req.kind === 'patch' ? 'Apply patch' : 'Run command');

    // Wire envelope: keep snake_case for the existing `permission_request`
    // channel. Renderer sees `kind`, `agent`, `summary`, `codex_payload`
    // alongside Claude's `tool_name`/`tool_input` (left blank — the
    // PermissionCard branches on `kind` before reading them).
    const payload = {
      type: 'permission_request',
      request_id: requestId,
      kind: req.kind,
      agent: 'codex',
      summary,
      codex_payload: req.payload,
      // Stub Claude fields so the renderer's existing normalizer doesn't
      // crash on `undefined`. These are intentionally not used by the
      // Codex branches in PermissionCard.
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
      payload: any;
      toolInput: Record<string, unknown>;
    } = {
      requestId,
      resolve: () => { /* engine flow uses engine.respondPermission directly */ },
      payload,
      toolInput: {},
    };
    handle.permissionQueue.push(entry);

    if (handle.permissionQueue.length === 1) {
      setStatus(handle, { conversationStatus: 'waiting_permission' }, tabId, sendToRenderer);
      sendToRenderer(`claude-output:${tabId}`, payload);

      const projectName = path.basename(handle.projectPath) || 'OmniFex';
      const title = `OmniFex — ${projectName}`;
      const body = truncate(summary);
      sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
      try {
        notificationHooks.showNotification?.(title, body, false, { tabId }, {
          subtitle: 'Permission Request:',
        });
        notificationHooks.incrementUnread?.();
      } catch (e) {
        console.error('[sessions] permission notification hook failed:', e);
      }
    }
  }

  return (req: AgentPermissionRequest): void => {
    // Codex emits patch / exec approval kinds with a fundamentally different
    // payload shape than Claude's canUseTool body (no tool_name, no rules to
    // edit — the approval is JSON-RPC respondToServer with a `decision`).
    // Branch here so the renderer wire payload carries enough context for the
    // PermissionCard to render a meaningful preview without re-parsing the
    // Claude vs Codex wire schema.
    if (req.kind === 'patch' || req.kind === 'exec') {
      handleCodexApprovalRequest(req);
      return;
    }

    // req.payload was the raw CLI control_request.request body — has
    // tool_name, input, tool_use_id, permission_suggestions, title, etc.
    const rawPayload = req.payload as {
      tool_name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      permission_suggestions?: unknown[];
      blocked_path?: string;
      decision_reason?: string;
      title?: string;
      display_name?: string;
      description?: string;
    };
    const toolName = rawPayload.tool_name ?? 'unknown';
    const toolInput = rawPayload.input ?? {};
    const toolUseID = rawPayload.tool_use_id ?? '';
    const requestId = req.requestId;
    const permissionMode = currentPermissionMode(handle);

    // bypassPermissions: auto-allow without prompting the user.
    if (permissionMode === 'bypassPermissions') {
      logEntry({
        level: 'info',
        message: `permission decision: allow ${toolName} (${permissionMode})`,
        metadata: {
          event: 'permission.decision',
          tool_name: toolName,
          tool_use_id: toolUseID,
          behavior: 'allow',
          persisted: false,
          permission_mode: permissionMode,
          auto_allowed: true,
        },
      });
      handle.engine?.respondPermission(requestId, 'allow', { updatedInput: toolInput })
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
      return;
    }

    let suggestions = rawPayload.permission_suggestions;
    const needsDefault =
      !suggestions ||
      suggestions.length === 0 ||
      suggestions.every(
        (s: any) =>
          !s ||
          !Array.isArray(s.rules) ||
          s.rules.length === 0 ||
          s.rules.every(
            (r: any) => !r || typeof r.toolName !== 'string' || !r.toolName.trim(),
          ),
      );
    if (needsDefault) {
      const defaultRule = buildDefaultRule(toolName, toolInput);
      if (defaultRule) {
        suggestions = [{
          type: 'addRules',
          rules: [defaultRule],
          behavior: 'allow',
          destination: 'localSettings',
        }];
      }
    }

    const payload = {
      type: 'permission_request',
      request_id: requestId,
      tool_name: toolName,
      tool_input: toolInput,
      title: rawPayload.title,
      display_name: rawPayload.display_name,
      description: rawPayload.description,
      decision_reason: rawPayload.decision_reason,
      blocked_path: rawPayload.blocked_path,
      permission_suggestions: suggestions,
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

    // Enqueue. respondPermission (below) will ship the decision back to
    // the engine when the user clicks. We carry the original tool input
    // and rule suggestions on the queue entry so respondPermission can
    // build the PermissionResult without re-parsing.
    const entry: PendingPermission & {
      payload: any;
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

    // If this is the only item in the queue, show it immediately.
    if (handle.permissionQueue.length === 1) {
      setStatus(handle, { conversationStatus: 'waiting_permission' }, tabId, sendToRenderer);
      sendToRenderer(`claude-output:${tabId}`, payload);

      const projectName = path.basename(handle.projectPath) || 'OmniFex';
      const title = `OmniFex — ${projectName}`;
      const { body, subtitle } = permissionNotificationContent(toolName, toolInput, {
        title: rawPayload.title,
        displayName: rawPayload.display_name,
      });
      sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
      try {
        notificationHooks.showNotification?.(title, body, false, { tabId }, { subtitle });
        notificationHooks.incrementUnread?.();
      } catch (e) {
        console.error('[sessions] permission notification hook failed:', e);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// respondPermission — called from IPC when the user clicks allow/deny
// ---------------------------------------------------------------------------

export function respondPermission(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
  behavior: 'allow' | 'deny',
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: PermissionDecision['updatedPermissions'],
  persistPermissionRule?: PersistPermissionRuleFn | null,
): void {
  if (handle.permissionQueue.length === 0) return;

  // Mirror persistent allow/deny rules with a session-destination twin so the
  // CLI applies them to the running session immediately. Without this twin,
  // the rule would land on disk but never enter the live process's rule
  // cache, and the very next matching tool_use would re-prompt — exactly
  // the "permissions never really stick" symptom.
  const augmented = behavior === 'allow'
    ? augmentPermissionsWithSession(updatedPermissions)
    : updatedPermissions;

  // Pop the head of the queue and ship the decision back to the engine.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- permissionQueue.shift() guarded by length > 0 (prior check).
  const current = handle.permissionQueue.shift()! as PendingPermission & {
    toolInput?: Record<string, unknown>;
    payload?: { kind?: 'tool' | 'patch' | 'exec' };
  };

  // Codex approval entries carry kind='patch'/'exec' on the queued payload.
  // Their engine.respondPermission accepts just `decision` — passing the
  // Claude-shaped { behavior, updatedInput, updatedPermissions } body would
  // spread garbage into Codex's JSON-RPC result envelope. Send no body for
  // Codex; the engine maps the `decision` arg onto the wire shape itself.
  const isCodexApproval =
    current.payload?.kind === 'patch' || current.payload?.kind === 'exec';

  if (handle.engine) {
    if (isCodexApproval) {
      handle.engine.respondPermission(current.requestId, behavior)
        .catch((e: unknown) => console.error('[sessions] engine.respondPermission failed:', e));
    } else {
      // PermissionResult body: behavior, updatedInput, optionally
      // updatedPermissions. The engine attaches the matching toolUseID
      // automatically from its pending-permission map.
      const permissionResultBody: Record<string, unknown> = { behavior };
      if (behavior === 'allow') {
        // updatedInput is required for allow. Fall back to the captured
        // original input (mirrors the SDK's "passing {} breaks it" rule).
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

  // Persist any rules whose destination isn't "session" — the SDK may also
  // write these internally, but we persist ourselves so rules always land on
  // disk regardless of SDK behavior. We iterate the *original* updates here
  // (not the augmented array) so we don't double-write the session twin.
  if (behavior === 'allow' && persistPermissionRule && updatedPermissions) {
    for (const suggestion of updatedPermissions) {
      const scope = scopeForDestination((suggestion as any).destination);
      if (!scope) continue;
      const rules = (suggestion as any).rules ?? [];
      const suggBehavior = (suggestion as any).behavior === 'deny' ? 'deny' : 'allow';
      for (const r of rules) {
        if (!r || typeof r.toolName !== 'string' || !r.toolName.trim()) continue;
        try {
          persistPermissionRule({
            scope,
            behavior: suggBehavior,
            rule: formatRule(r),
            configDir: handle.configDir,
            projectPath: handle.projectPath,
          });
        } catch (e) {
          console.error('[sessions] persistPermissionRule failed:', e);
        }
      }
    }
  }

  // Show the next queued request, if any
  if (handle.permissionQueue.length > 0) {
    const next = handle.permissionQueue[0];
    const nextPayload = (next as any).payload;
    sendToRenderer(`claude-output:${tabId}`, nextPayload);

    // Notify the user about the next permission in the queue
    const projectName = path.basename(handle.projectPath) || 'OmniFex';
    const title = `OmniFex — ${projectName}`;
    let body: string;
    let subtitle: string;
    if (nextPayload.kind === 'patch' || nextPayload.kind === 'exec') {
      // Codex approval — use the engine-supplied summary directly.
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
    sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
    try {
      notificationHooks.showNotification?.(title, body, false, { tabId }, { subtitle });
      notificationHooks.incrementUnread?.();
    } catch (e) {
      console.error('[sessions] permission notification hook failed:', e);
    }
  } else {
    // Queue drained — back to running until the SDK emits its 'result'
    // for this turn, at which point runtime.ts flips to 'idle'.
    setStatus(handle, { conversationStatus: 'running' }, tabId, sendToRenderer);
  }
}

