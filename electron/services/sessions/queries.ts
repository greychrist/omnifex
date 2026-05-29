// Sessions module — engine-driven query passthroughs
//
// Each method looks up the session handle for the tab and forwards to the
// engine's stream-json control protocol (sendControlRequest) or its cached
// init data (getInitData). Unknown / TUI tabs are no-ops. Engine errors
// are swallowed and reported as null/[] so a CLI hiccup doesn't crash the
// IPC layer.

import type {
  SessionHandle,
  SessionStartParams,
  PermissionMode,
  AccountInfo,
  AgentInfo,
  ModelInfo,
  SlashCommand,
  CliControlGetContextUsageResponse,
  McpServerStatus,
  SendToRenderer,
} from './types';
import { enrichPlugin, type EnrichedPlugin } from './plugins';

export function createQueryPassthroughs(
  sessions: Map<string, SessionHandle>,
  sendToRenderer: SendToRenderer | null = null,
) {
  function liveEngine(tabId: string): SessionHandle | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    // TUI mode: the live conversation is the PTY, not the engine. Treat
    // control_requests as no-ops while in TUI; the renderer's queries.ts
    // calls already silently fall through when no engine was available.
    if (handle.mode === 'tui') return null;
    if (!handle.engine) return null;
    return handle;
  }

  async function interrupt(tabId: string): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) return;
    try {
      await handle.engine!.interrupt();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] interrupt failed for tab ${tabId}:`, err);
      sendToRenderer?.(`agent-output:${tabId}`, {
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
    const handle = liveEngine(tabId);
    if (!handle) return;
    try {
      await handle.engine!.sendControlRequest('set_model', { model });
    } catch (err) {
      console.error(`[sessions] setModel failed for tab ${tabId}:`, err);
    }
  }

  async function setPermissionMode(tabId: string, mode: PermissionMode): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) return;
    handle.permissionMode = mode;
    try {
      await handle.engine!.sendControlRequest('set_permission_mode', { mode });
    } catch (err) {
      console.error(`[sessions] setPermissionMode failed for tab ${tabId}:`, err);
    }
  }

  async function setEffort(
    tabId: string,
    level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
  ): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) return;
    try {
      await handle.engine!.sendControlRequest('apply_flag_settings', {
        settings: { effortLevel: level ?? undefined },
      });
    } catch (err) {
      console.error(`[sessions] setEffort failed for tab ${tabId}:`, err);
    }
  }

  // Push rule lists into the live session. Required because the CLI loads
  // settings files only at session start; rule edits made via the UI later
  // (settings panel, "Add Rule" sidebar) sit on disk but the running
  // session never sees them, so it keeps prompting for things the user
  // already allowed. apply_flag_settings shallow-merges the permissions
  // key, so callers must send the full effective allow/deny list each
  // time, not just the delta.
  async function applyPermissions(
    tabId: string,
    permissions: { allow?: string[]; deny?: string[]; ask?: string[] },
  ): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) return;
    try {
      await handle.engine!.sendControlRequest('apply_flag_settings', {
        settings: { permissions },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] applyPermissions failed for tab ${tabId}:`, err);
      sendToRenderer?.(`agent-output:${tabId}`, {
        type: 'system',
        subtype: 'notification',
        notification_type: 'warn',
        title: 'Permission rule saved on disk but not applied to live session',
        body:
          `Restart the session to apply the new rules. ` +
          `(apply_flag_settings failed: ${errMsg.slice(0, 200)})`,
      });
    }
  }

  async function setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) return;
    try {
      // Two states only — see memory reference_thinking_sdk_deprecation:
      // 0 means "disabled" across versions; null means "adaptive default."
      // Non-zero values collapse to adaptive on Opus 4.6+ so we don't
      // bother distinguishing fixed-budget vs adaptive on the wire.
      const value = !config || config.type === 'disabled' ? 0 : null;
      await handle.engine!.sendControlRequest('set_max_thinking_tokens', {
        max_thinking_tokens: value,
      });
    } catch (err) {
      console.error(`[sessions] setThinking failed for tab ${tabId}:`, err);
    }
  }

  async function getAccountInfo(tabId: string): Promise<AccountInfo | null> {
    const handle = sessions.get(tabId);
    if (!handle?.engine) return null;
    const init = handle.engine.getInitData();
    return (init?.account as AccountInfo | undefined) ?? null;
  }

  async function getContextUsage(
    tabId: string,
  ): Promise<CliControlGetContextUsageResponse | null> {
    const handle = liveEngine(tabId);
    if (!handle) return null;
    try {
      return await handle.engine!.sendControlRequest<CliControlGetContextUsageResponse>(
        'get_context_usage',
      );
    } catch (err) {
      console.error(`[sessions] getContextUsage failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getSupportedCommands(tabId: string): Promise<SlashCommand[]> {
    const handle = sessions.get(tabId);
    if (!handle?.engine) return [];
    const init = handle.engine.getInitData();
    return (init?.commands as SlashCommand[] | undefined) ?? [];
  }

  async function getSupportedModels(tabId: string): Promise<ModelInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle?.engine) return [];
    const init = handle.engine.getInitData();
    return (init?.models as ModelInfo[] | undefined) ?? [];
  }

  async function getSupportedAgents(tabId: string): Promise<AgentInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle?.engine) return [];
    const init = handle.engine.getInitData();
    return (init?.agents as AgentInfo[] | undefined) ?? [];
  }

  async function getMcpServerStatus(tabId: string): Promise<McpServerStatus[]> {
    const handle = liveEngine(tabId);
    if (!handle) return [];
    try {
      const result = await Promise.race([
        handle.engine!.sendControlRequest<{ mcpServers: McpServerStatus[] }>('mcp_status'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (result?.mcpServers && result.mcpServers.length > 0) return result.mcpServers;
    } catch { /* engine not ready */ }
    return [];
  }

  // reload_plugins is side-effectful so cache per-tab and only refresh
  // when the caller explicitly asks. Cache is keyed by tabId; lifecycle
  // calls evictPluginCache(tabId) on session stop so entries don't
  // accumulate forever.
  const pluginCache = new Map<string, EnrichedPlugin[]>();
  function evictPluginCache(tabId: string): void {
    pluginCache.delete(tabId);
  }

  async function getPlugins(tabId: string, force = false): Promise<EnrichedPlugin[]> {
    const handle = liveEngine(tabId);
    if (!handle) return [];
    if (!force) {
      const cached = pluginCache.get(tabId);
      if (cached) return cached;
    }
    try {
      const result = await Promise.race([
        handle.engine!.sendControlRequest<{ plugins: unknown[] }>('reload_plugins'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!result) return pluginCache.get(tabId) ?? [];
      const enriched = (result.plugins ?? []).map((p: unknown) =>
        enrichPlugin(p as Parameters<typeof enrichPlugin>[0], {
          configDir: handle.configDir,
          projectPath: handle.projectPath,
        }),
      );
      pluginCache.set(tabId, enriched);
      return enriched;
    } catch (err) {
      console.error(`[sessions] reload_plugins failed for tab ${tabId}:`, err);
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
