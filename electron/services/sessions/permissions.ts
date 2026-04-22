// Sessions module — permission handling
// Extracted from electron/services/sessions.ts (pure refactor)

import path from 'node:path';
import type { LoggingService } from '../logging';
import type {
  SessionHandle,
  PermissionDecision,
  PendingPermission,
  SendToRenderer,
  NotificationHooks,
} from './types';

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

    // If the SDK doesn't provide suggestions, generate a sensible default
    // from the tool name and input so the user can still save a rule.
    let suggestions = toolOptions.suggestions;
    if (!suggestions || suggestions.length === 0) {
      let ruleContent: string | undefined;
      if (toolName === 'Bash' && typeof toolInput.command === 'string') {
        // Extract the base command for a wildcard rule: "git status" → "git:*"
        const cmd = (toolInput.command as string).trim();
        const base = cmd.split(/[\s;|&]/)[0];
        ruleContent = base ? `${base}:*` : cmd;
      } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
        ruleContent = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
      }
      if (ruleContent) {
        suggestions = [{
          type: 'addRules',
          rules: [{ toolName, ruleContent }],
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
): void {
  if (handle.permissionQueue.length === 0) return;

  // Resolve the front of the queue
  const current = handle.permissionQueue.shift()!;
  current.resolve({ behavior, updatedInput, updatedPermissions });

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

// ---------------------------------------------------------------------------
// setAutoAllow / addAutoAllowTool
// ---------------------------------------------------------------------------

export function setAutoAllow(handle: SessionHandle, enabled: boolean): void {
  handle.autoAllowEnabled = enabled;
}

export function addAutoAllowTool(handle: SessionHandle, toolName: string): void {
  handle.autoAllowedTools.add(toolName);
}
