// Sessions module — Wave 2 query-method passthroughs
// Extracted from electron/services/sessions.ts (pure refactor)

import type {
  SessionHandle,
  SessionStartParams,
  PermissionMode,
  AccountInfo,
  AgentInfo,
  ModelInfo,
  SlashCommand,
  SDKControlGetContextUsageResponse,
  McpServerStatus,
  SendToRenderer,
} from './types';
import { enrichPlugin, type EnrichedPlugin } from './plugins';

// ---------------------------------------------------------------------------
// createQueryPassthroughs
//
// Each method looks up the session handle for the tab and forwards to the
// corresponding SDK Query method. Unknown tabs are no-ops (return null or []
// depending on the expected shape). SDK errors are swallowed and reported
// as null/[] so a misbehaving subprocess can't crash the IPC layer.
// ---------------------------------------------------------------------------

export function createQueryPassthroughs(
  sessions: Map<string, SessionHandle>,
  sendToRenderer: SendToRenderer | null = null,
) {
  async function interrupt(tabId: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.interrupt();
    } catch (err) {
      // Stop is user-facing — a silent failure leaves the user mashing the
      // button with the stream still running and no UI signal. Mirror the
      // pattern in applyPermissions: log + surface a system notification.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] interrupt failed for tab ${tabId}:`, err);
      sendToRenderer?.(`claude-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'error',
        title: 'Stop request failed',
        body:
          `The session may still be running. Try again, or restart the session ` +
          `if it stays stuck. (interrupt failed: ${errMsg.slice(0, 200)})`,
      });
    }
  }

  async function setModel(tabId: string, model?: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.setModel(model);
    } catch (err) {
      console.error(`[sessions] setModel failed for tab ${tabId}:`, err);
    }
  }

  async function setPermissionMode(tabId: string, mode: PermissionMode): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    handle.sdkOptions.permissionMode = mode;
    if (mode === 'bypassPermissions') {
      handle.sdkOptions.allowDangerouslySkipPermissions = true;
    }
    try {
      await handle.query.setPermissionMode(mode);
    } catch (err) {
      console.error(`[sessions] setPermissionMode failed for tab ${tabId}:`, err);
    }
  }

  async function setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.applyFlagSettings({ effortLevel: level ?? undefined } as any);
    } catch (err) {
      console.error(`[sessions] setEffort failed for tab ${tabId}:`, err);
    }
  }

  // Push rule lists into the live SDK session. Required because the SDK loads
  // settings files only at session start; rule edits made via the UI later
  // (settings panel, "Add Rule" sidebar) sit on disk but the running session
  // never sees them, so it keeps prompting for things the user already allowed.
  // applyFlagSettings shallow-merges the `permissions` key, so callers must
  // send the full effective allow/deny list each time, not just the delta.
  async function applyPermissions(
    tabId: string,
    permissions: { allow?: string[]; deny?: string[]; ask?: string[] },
  ): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.applyFlagSettings({ permissions });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] applyPermissions failed for tab ${tabId}:`, err);
      // Surface the failure to the chat as a warning. The rule was already
      // written to disk by the caller — the user thinks "I just allowed
      // this," but the live SDK session never picked up the change and
      // will keep prompting until restart. Without this warning, the
      // mismatch is invisible.
      sendToRenderer?.(`claude-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'warn',
        title: 'Permission rule saved on disk but not applied to live session',
        body:
          `Restart the session to apply the new rules. ` +
          `(applyFlagSettings failed: ${errMsg.slice(0, 200)})`,
      });
    }
  }

  async function setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      // Two states only as of v0.4.21 — the SDK's `setMaxThinkingTokens`
      // collapses every non-zero value to adaptive on Opus 4.6+, so the
      // old `enabled` (fixed-budget) branch produced identical runtime
      // behavior to `adaptive` while pretending otherwise. Treat any
      // `enabled` value the renderer might still send as adaptive so a
      // stale-state caller doesn't fall through silently.
      // `null` is the documented "unset; use default" sentinel on the SDK
      // signature (`number | null`) and is what we want for adaptive — the
      // CLI then picks the right adaptive behavior for the active model.
      // Do not "fix" this to `1` or another positive int: those are a
      // literal budget claim and would be honored as such if Anthropic
      // ever loosens the current "non-zero collapses to adaptive on Opus
      // 4.6+" rule. `null` continues to mean "default" across versions.
      if (!config || config.type === 'disabled') {
        await handle.query.setMaxThinkingTokens(0);
      } else {
        await handle.query.setMaxThinkingTokens(null);
      }
    } catch (err) {
      console.error(`[sessions] setThinking failed for tab ${tabId}:`, err);
    }
  }

  async function getAccountInfo(tabId: string): Promise<AccountInfo | null> {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    try {
      return await handle.query.accountInfo();
    } catch (err) {
      console.error(`[sessions] accountInfo failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getContextUsage(
    tabId: string,
  ): Promise<SDKControlGetContextUsageResponse | null> {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    try {
      return await handle.query.getContextUsage();
    } catch (err) {
      console.error(`[sessions] getContextUsage failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getSupportedCommands(tabId: string): Promise<SlashCommand[]> {
    const handle = sessions.get(tabId);
    if (!handle) {
      console.warn(`[sessions] getSupportedCommands: no handle for tab ${tabId}`);
      return [];
    }
    try {
      const cmds = await handle.query.supportedCommands();
      return cmds;
    } catch (err) {
      console.error(`[sessions] supportedCommands failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getSupportedModels(tabId: string): Promise<ModelInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedModels();
    } catch (err) {
      console.error(`[sessions] supportedModels failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getSupportedAgents(tabId: string): Promise<AgentInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedAgents();
    } catch (err) {
      console.error(`[sessions] supportedAgents failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getMcpServerStatus(tabId: string): Promise<McpServerStatus[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];

    // Ask the SDK for live MCP server status (includes tools, versions, scopes).
    // Times out after 3s so the panel doesn't hang if the session is still starting.
    try {
      const result = await Promise.race([
        handle.query.mcpServerStatus(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (result && result.length > 0) return result;
    } catch { /* SDK not ready */ }

    return [];
  }

  // reloadPlugins is a side-effectful SDK call, so cache per-tab and only
  // refresh when the caller explicitly asks. Cache is keyed by tabId; the
  // lifecycle layer calls evictPluginCache(tabId) on session stop so
  // entries don't accumulate forever.
  const pluginCache = new Map<string, EnrichedPlugin[]>();

  function evictPluginCache(tabId: string): void {
    pluginCache.delete(tabId);
  }

  async function getPlugins(tabId: string, force = false): Promise<EnrichedPlugin[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    if (!force) {
      const cached = pluginCache.get(tabId);
      if (cached) return cached;
    }

    try {
      const result = await Promise.race([
        handle.query.reloadPlugins(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!result) return pluginCache.get(tabId) ?? [];

      const enriched = result.plugins.map((p) =>
        enrichPlugin(p, {
          configDir: handle.configDir,
          projectPath: handle.projectPath,
        }),
      );
      pluginCache.set(tabId, enriched);
      return enriched;
    } catch (err) {
      console.error(`[sessions] reloadPlugins failed for tab ${tabId}:`, err);
      return pluginCache.get(tabId) ?? [];
    }
  }

  return {
    interrupt,
    setModel,
    setPermissionMode,
    setEffort,
    applyPermissions,
    setThinking,
    getAccountInfo,
    getContextUsage,
    getSupportedCommands,
    getSupportedModels,
    getSupportedAgents,
    getMcpServerStatus,
    getPlugins,
    evictPluginCache,
  };
}
