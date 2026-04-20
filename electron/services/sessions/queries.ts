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

export function createQueryPassthroughs(sessions: Map<string, SessionHandle>) {
  async function interrupt(tabId: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.interrupt();
    } catch (err) {
      console.error(`[sessions] interrupt failed for tab ${tabId}:`, err);
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

  async function setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      if (!config || config.type === 'disabled') {
        await handle.query.setMaxThinkingTokens(0);
      } else if (config.type === 'adaptive') {
        await handle.query.setMaxThinkingTokens(null);
      } else if (config.type === 'enabled') {
        await handle.query.setMaxThinkingTokens(config.budgetTokens ?? null);
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
      console.log(`[sessions] getSupportedCommands(${tabId}): returned ${cmds?.length ?? 0} commands`, cmds?.map(c => c.name));
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
  // refresh when the caller explicitly asks. Cache is keyed by tabId; stale
  // entries from closed tabs are harmless.
  const pluginCache = new Map<string, EnrichedPlugin[]>();

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
    setThinking,
    getAccountInfo,
    getContextUsage,
    getSupportedCommands,
    getSupportedModels,
    getSupportedAgents,
    getMcpServerStatus,
    getPlugins,
  };
}
