// Sessions module — lifecycle orchestrator (factory + session management)
// Extracted from electron/services/sessions.ts (pure refactor)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsyncChannel } from '../async-channel';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKUserMessage,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionHandle,
  SessionStartParams,
  SessionStatus,
  SessionsService,
  SendToRenderer,
  NotificationHooks,
  PermissionDecision,
  LoggingService,
  SessionOwnership,
} from './types';
import { createSessionHooks } from './hooks';
import {
  createCanUseTool,
  respondPermission as respondPermissionImpl,
  setAutoAllow as setAutoAllowImpl,
  addAutoAllowTool as addAutoAllowToolImpl,
} from './permissions';
import { createQueryPassthroughs } from './queries';

// ---------------------------------------------------------------------------
// findSystemClaudeBinary
// ---------------------------------------------------------------------------

/** Find the system-installed claude binary (needed because the SDK's bundled binary may be missing). */
function findSystemClaudeBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionsService(
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks = {},
  logging: LoggingService | null = null,
  ownership: SessionOwnership | null = null,
): SessionsService {
  const sessions = new Map<string, SessionHandle>();

  // -------------------------------------------------------------------------
  // Internal: start the async listener loop for a session
  // -------------------------------------------------------------------------

  async function listenToMessages(tabId: string, handle: SessionHandle): Promise<void> {
    try {
      for await (const message of handle.query) {
        // Extract session ID from system init message
        if (
          message.type === 'system' &&
          (message as any).subtype === 'init' &&
          (message as any).session_id
        ) {
          handle.sessionId = (message as any).session_id as string;
        }

        handle.status = 'running';

        // Forward every message to the renderer
        sendToRenderer(`claude-output:${tabId}`, message);

        // Emit notification event on result messages (execution complete/failed)
        if (message.type === 'result') {
          const msg = message as any;
          const isError = msg.is_error || msg.subtype === 'error';
          const projectName = path.basename(handle.projectPath) || 'GreyChrist';
          const title = `GreyChrist — ${projectName}`;
          const body = (msg.result || msg.error || (isError ? 'Task failed' : 'Task complete')).slice(0, 200);

          // Emit to renderer for in-app tab badge handling
          sendToRenderer('claude-notification', {
            tab_id: tabId,
            title,
            body,
            is_error: isError,
          });

          // Fire native OS notification + dock badge
          try {
            notificationHooks.showNotification?.(title, body, isError);
            notificationHooks.incrementUnread?.();
          } catch (e) {
            console.error('[sessions] notification hook failed:', e);
          }
        }
      }
    } catch (err) {
      // Stream error — keep the session alive so the user can retry.
      // The next sendMessage() will restart the SDK query transparently.
      handle.status = 'error';
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`claude-error:${tabId}`, errMsg);
      sendToRenderer(`claude-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: 'Session Error',
        message: `Error: ${errMsg.slice(0, 200)}`,
      });
      // Stop the loading indicator but keep the session in the map
      sendToRenderer(`claude-complete:${tabId}`);
      return;
    }
    // Normal stream close — clean up
    handle.status = 'stopped';
    sendToRenderer(`claude-complete:${tabId}`);
    sessions.delete(tabId);
    ownership?.unregister(tabId);
  }

  // -------------------------------------------------------------------------
  // Internal: restart a dead query (after stream error) so the session resumes
  // -------------------------------------------------------------------------

  function restartQuery(tabId: string, handle: SessionHandle): void {
    const newInputChannel = createAsyncChannel<SDKUserMessage>(1000);
    const opts = { ...handle.sdkOptions };
    if (handle.sessionId) {
      opts.resume = handle.sessionId;
    }

    const q = query({
      prompt: newInputChannel,
      options: opts as any,
    });

    handle.inputChannel = newInputChannel;
    handle.query = q;
    handle.status = 'starting';

    listenToMessages(tabId, handle).catch((err) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });
  }

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  function start(params: SessionStartParams): void {
    const {
      tabId,
      projectPath,
      configDir,
      model,
      permissionMode,
      resumeSessionId,
      effort,
      thinking,
    } = params;

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      existing.inputChannel.close();
      existing.query.close();
      sessions.delete(tabId);
      ownership?.unregister(tabId);
    }

    const inputChannel = createAsyncChannel<SDKUserMessage>(1000);

    // Build the SDK options
    const options: Record<string, unknown> = {
      cwd: projectPath,
      model,
      permissionMode: permissionMode as PermissionMode,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
      },
      // Use the full Claude Code CLI system prompt. Without this the SDK ships a minimal
      // prompt and sessions lose the plan-first / ask-clarifying-questions / tool-use
      // conventions that make Claude Code feel like Claude Code.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Load project CLAUDE.md, .claude/skills/*, .claude/commands/*, .claude/settings.json,
      // and user ~/.claude/settings.json. Without this the SDK runs in isolation mode and
      // ignores all filesystem-based project config — defeating the point of a Claude Code GUI.
      // Note: the claude_code preset alone does NOT load CLAUDE.md — settingSources is required.
      settingSources: ['user', 'project', 'local'],
      // Auto-approve all project .mcp.json servers so they connect without
      // interactive approval (which the SDK would otherwise silently decline).
      // `showThinkingSummaries: true` opts out of the CLI's default redact-thinking
      // beta header so the API returns summary text in thinking blocks (otherwise
      // we get signature-only blocks with empty `thinking` text).
      settings: {
        enableAllProjectMcpServers: true,
        showThinkingSummaries: true,
      },
      // Surface malformed MCP configs as startup errors instead of swallowing
      // them as silent warnings. Matches the behaviour used by agents.ts.
      strictMcpConfig: true,
      // Elicitation: prompt the user via the renderer instead of auto-accepting.
      onElicitation: async (request: any) => {
        // URL mode: open browser immediately, then wait for user decision
        if (request.mode === 'url' && request.url) {
          try {
            const { shell } = require('electron') as typeof import('electron');
            shell.openExternal(request.url);
          } catch { /* best effort */ }
        }

        // Send the request to the renderer and wait for the user's decision
        sendToRenderer(`elicitation-request:${tabId}`, {
          serverName: request.serverName,
          message: request.message,
          mode: request.mode,
          url: request.url,
          elicitationId: request.elicitationId,
          requestedSchema: request.requestedSchema,
        });

        return new Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>((resolve) => {
          handle.elicitationResolver = (decision) => {
            handle.elicitationResolver = null;
            resolve({ action: decision.action, content: decision.content });
          };
        });
      },
    };

    if (effort) {
      options.effort = effort;
    }
    if (thinking) {
      options.thinking = thinking;
    }

    // Route CLI subprocess stderr into the logging service. Note the CLI routes its
    // own `--debug` output to ~/.claude-personal/debug/<sessionId>.txt (not stderr),
    // so this callback only catches unexpected stderr (crashes, fatal errors).
    if (logging) {
      options.stderr = (data: string) => {
        // Detect error-like patterns in stderr and log at appropriate level
        const isError = /^error[:\s]|Error in hook callback|stream closed|FATAL|panic/i.test(data);
        logging.writeBatch([
          {
            timestamp: new Date().toISOString(),
            level: isError ? 'error' : 'debug',
            source: 'claude-sdk',
            category: `session:${tabId}`,
            message: data,
          },
        ]);
      };

    }

    // Audit hooks — createSessionHooks handles null logging internally
    options.hooks = createSessionHooks(tabId, logging, sendToRenderer, notificationHooks);

    // ---- canUseTool: primary permission handler ----
    // Called by the SDK before each tool execution. The SDK may call this
    // concurrently for parallel tool use — we queue requests and show them
    // one at a time so the user isn't overwhelmed.

    // Create handle first so the PermissionRequest hook callback can reference it
    const handle: SessionHandle = {
      query: null as any, // set below
      inputChannel,
      sessionId: null,
      status: 'starting',
      permissionResolver: null,
      permissionQueue: [],
      elicitationResolver: null,
      autoAllowEnabled: false,
      autoAllowedTools: new Set(),
      projectPath,
      configDir: (() => {
        if (!configDir) throw new Error(`configDir is required to start session for tab ${tabId}`);
        return configDir;
      })(),
      sdkOptions: options,
    };

    options.canUseTool = createCanUseTool(handle, tabId, sendToRenderer, notificationHooks);

    // Use system-installed claude binary (account is scoped via CLAUDE_CONFIG_DIR)
    const binaryPath = findSystemClaudeBinary();
    if (binaryPath) {
      options.pathToClaudeCodeExecutable = binaryPath;
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Start the SDK query with the async input channel
    const q = query({
      prompt: inputChannel,
      options: options as any,
    });

    handle.query = q;
    sessions.set(tabId, handle);
    if (params.ownerWebContentsId !== undefined) {
      ownership?.register(tabId, params.ownerWebContentsId);
    }

    // Start listening in the background (don't await — fire and forget)
    listenToMessages(tabId, handle).catch((err) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });
  }

  // -------------------------------------------------------------------------
  // sendMessage()
  // -------------------------------------------------------------------------

  function sendMessage(tabId: string, prompt: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    // If the previous stream errored, restart the SDK query transparently
    if (handle.status === 'error') {
      restartQuery(tabId, handle);
    }

    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: prompt,
      },
      parent_tool_use_id: null,
    };

    handle.inputChannel.push(message);
  }

  function sendStructuredMessage(
    tabId: string,
    content: Array<Record<string, unknown>>,
  ): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    // If the previous stream errored, restart the SDK query transparently
    if (handle.status === 'error') {
      restartQuery(tabId, handle);
    }

    const message: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: content as any,
      },
      parent_tool_use_id: null,
    };

    handle.inputChannel.push(message);
  }

  // -------------------------------------------------------------------------
  // rebind()
  // -------------------------------------------------------------------------

  function rebind(tabId: string, ownerWebContentsId: number): boolean {
    const handle = sessions.get(tabId);
    if (!handle) return false;
    ownership?.register(tabId, ownerWebContentsId);
    return true;
  }

  // -------------------------------------------------------------------------
  // respondPermission()
  // -------------------------------------------------------------------------

  function respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
  ): void {
    const handle = sessions.get(tabId);
    if (!handle || handle.permissionQueue.length === 0) return;

    respondPermissionImpl(handle, tabId, sendToRenderer, notificationHooks, behavior, updatedInput, updatedPermissions);
  }

  // -------------------------------------------------------------------------
  // respondElicitation()
  // -------------------------------------------------------------------------

  function respondElicitation(
    tabId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ): void {
    const handle = sessions.get(tabId);
    if (!handle?.elicitationResolver) return;
    handle.elicitationResolver({ action, content });
  }

  // -------------------------------------------------------------------------
  // setAutoAllow() / addAutoAllowTool()
  // -------------------------------------------------------------------------

  function setAutoAllow(tabId: string, enabled: boolean): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    setAutoAllowImpl(handle, enabled);
  }

  function addAutoAllowTool(tabId: string, toolName: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    addAutoAllowToolImpl(handle, toolName);
  }

  // -------------------------------------------------------------------------
  // stop() / stopAll()
  // -------------------------------------------------------------------------

  function stop(tabId: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;

    handle.inputChannel.close();
    handle.query.close();
    sessions.delete(tabId);
    ownership?.unregister(tabId);
  }

  function stopAll(): void {
    for (const tabId of sessions.keys()) {
      stop(tabId);
    }
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  function getSessionId(tabId: string): string | null {
    return sessions.get(tabId)?.sessionId ?? null;
  }

  function getStatus(tabId: string): SessionStatus {
    return sessions.get(tabId)?.status ?? 'stopped';
  }

  function getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    return { sessionId: handle.sessionId, status: handle.status };
  }

  function isActive(tabId: string): boolean {
    return sessions.has(tabId);
  }

  function getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null } {
    const handle = sessions.get(tabId);
    if (!handle) return { alive: false, status: 'stopped', sessionId: null };
    return { alive: true, status: handle.status, sessionId: handle.sessionId };
  }

  // -------------------------------------------------------------------------
  // Return service
  // -------------------------------------------------------------------------

  return {
    start,
    rebind,
    sendMessage,
    sendStructuredMessage,
    respondPermission,
    respondElicitation,
    setAutoAllow,
    addAutoAllowTool,
    stop,
    stopAll,
    getSessionId,
    getStatus,
    getInfo,
    getHealth,
    isActive,
    ...createQueryPassthroughs(sessions),
  };
}
