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

function currentPermissionMode(handle: SessionHandle): string {
  const mode = handle.sdkOptions.permissionMode;
  return typeof mode === 'string' ? mode : 'default';
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
    if (u && u.type === 'addRules' && u.destination !== 'session') {
      out.push({ ...u, destination: 'session' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// createCanUseTool — the SDK's canUseTool callback
// ---------------------------------------------------------------------------

export function createCanUseTool(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
  logging: LoggingService | null = null,
): (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOptions: {
    signal: AbortSignal;
    suggestions?: any[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
  },
) => Promise<any> {
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

  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOptions: {
      signal: AbortSignal;
      suggestions?: any[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<any> => {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const permissionMode = currentPermissionMode(handle);

    if (permissionMode === 'bypassPermissions') {
      logEntry({
        level: 'info',
        message: `permission decision: allow ${toolName} (${permissionMode})`,
        metadata: {
          event: 'permission.decision',
          tool_name: toolName,
          tool_use_id: toolOptions.toolUseID,
          behavior: 'allow',
          persisted: false,
          permission_mode: permissionMode,
          auto_allowed: true,
        },
      });
      return {
        behavior: 'allow' as const,
        updatedInput: toolInput,
      };
    }

    // Build a sensible default rule from the tool name and input. Used when
    // the SDK gives us nothing OR gives us a suggestion with an empty rules
    // array (which would otherwise render as a blank row in the dialog).
    const buildDefaultRule = (): { toolName: string; ruleContent?: string } | null => {
      if (toolName === 'Bash' && typeof toolInput.command === 'string') {
        const cmd = (toolInput.command as string).trim();
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
        // Format per Claude Code's gitignore-style rule syntax: prefer a
        // project-anchored relative path ("/rel/path") when the file lives
        // inside the session root, fall back to double-slash absolute
        // ("//abs/path") otherwise. A naive single-slash absolute path is
        // SILENTLY ineffective — it would be parsed as project-relative.
        return { toolName, ruleContent: formatFilePathForRule(fp, handle.projectPath) };
      }
      if (toolName === 'Glob' || toolName === 'Grep') {
        const pattern = typeof toolInput.pattern === 'string' ? toolInput.pattern : undefined;
        return pattern ? { toolName, ruleContent: pattern } : { toolName };
      }
      if (toolName === 'WebFetch' && typeof toolInput.url === 'string') {
        try {
          const u = new URL(toolInput.url as string);
          return { toolName, ruleContent: `domain:${u.hostname}` };
        } catch {
          return { toolName };
        }
      }
      // Any tool can be allowed by bare name as a last resort.
      return { toolName };
    };

    let suggestions = toolOptions.suggestions;
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
      const defaultRule = buildDefaultRule();
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
      title: toolOptions.title,
      display_name: toolOptions.displayName,
      description: toolOptions.description,
      decision_reason: toolOptions.decisionReason,
      blocked_path: toolOptions.blockedPath,
      permission_suggestions: suggestions,
    };

    logEntry({
      level: 'info',
      message: `permission request: ${toolName}`,
      metadata: {
        event: 'permission.request',
        tool_name: toolName,
        tool_use_id: toolOptions.toolUseID,
        tool_input: toolInput,
        request_id: requestId,
        suggestions,
      },
    });

    const decision = await new Promise<PermissionDecision>((resolve) => {
      const entry: PendingPermission & { payload: any } = { requestId, resolve, payload };
      handle.permissionQueue.push(entry);
      // If this is the only item in the queue, show it immediately
      if (handle.permissionQueue.length === 1) {
        handle.status = 'waiting_permission';
        sendToRenderer(`claude-output:${tabId}`, payload);

        // Notify the user that a permission decision is needed
        const projectName = path.basename(handle.projectPath) || 'GreyChrist';
        const title = `GreyChrist — ${projectName}`;
        const body = `Permission requested: ${toolName}`;
        sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
        try {
          notificationHooks.showNotification?.(title, body, false, { tabId });
          notificationHooks.incrementUnread?.();
        } catch (e) {
          console.error('[sessions] permission notification hook failed:', e);
        }
      }
      // Otherwise it waits — sendNextPermission will show it when the current one resolves
    });

    if (decision.behavior === 'allow') {
      // updatedInput is REQUIRED and must be the original tool input
      // (or a modified version). Passing {} breaks the SDK.
      const result: Record<string, unknown> = {
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? toolInput,
      };
      const persisted =
        !!decision.updatedPermissions && decision.updatedPermissions.length > 0;
      if (persisted) {
        result.updatedPermissions = decision.updatedPermissions;
      }

      const firstPerm = decision.updatedPermissions?.[0];
      logEntry({
        level: 'info',
        message: `permission decision: allow ${toolName}${persisted ? ' (saved)' : ' (session only)'}`,
        metadata: {
          event: 'permission.decision',
          tool_name: toolName,
          tool_use_id: toolOptions.toolUseID,
          behavior: 'allow',
          persisted,
          destination: firstPerm?.destination,
          rules: firstPerm?.rules,
        },
      });

      return result;
    }

    logEntry({
      level: 'info',
      message: `permission decision: deny ${toolName}`,
      metadata: {
        event: 'permission.decision',
        tool_name: toolName,
        tool_use_id: toolOptions.toolUseID,
        behavior: 'deny',
        persisted: false,
      },
    });
    return {
      behavior: 'deny' as const,
      message: 'User denied permission',
    };
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
  // SDK applies them to the running query immediately. Without this twin, the
  // rule would land on disk but never enter the live process's rule cache,
  // and the very next matching tool_use would re-prompt — exactly the
  // "permissions never really stick" symptom.
  const augmented = behavior === 'allow'
    ? augmentPermissionsWithSession(updatedPermissions)
    : updatedPermissions;

  // Resolve the front of the queue
  const current = handle.permissionQueue.shift()!;
  current.resolve({ behavior, updatedInput, updatedPermissions: augmented });

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
    const projectName = path.basename(handle.projectPath) || 'GreyChrist';
    const title = `GreyChrist — ${projectName}`;
    const body = `Permission requested: ${nextPayload.tool_name}`;
    sendToRenderer('claude-notification', { tab_id: tabId, title, body, is_error: false });
    try {
      notificationHooks.showNotification?.(title, body, false, { tabId });
      notificationHooks.incrementUnread?.();
    } catch (e) {
      console.error('[sessions] permission notification hook failed:', e);
    }
  } else {
    handle.status = 'running';
  }
}

