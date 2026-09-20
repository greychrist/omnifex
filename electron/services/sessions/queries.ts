// Sessions module — engine-driven query passthroughs
//
// Each method looks up the session handle for the tab and forwards to the
// engine's stream-json control protocol (sendControlRequest) or its cached
// init data (getInitData). Unknown tabs are no-ops. Engine errors
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
  CliPermissionRulesState,
  McpServerStatus,
  SendToRenderer,
} from './types';
import { enrichPlugin, type EnrichedPlugin } from './plugins';
import type { LoggingService } from '../logging';

export function createQueryPassthroughs(
  sessions: Map<string, SessionHandle>,
  sendToRenderer: SendToRenderer | null = null,
  logging: LoggingService | null = null,
) {
  // Persist a control-protocol diagnostic to app_logs. console.error alone
  // never reaches the DB, which is why mid-session setting changes that
  // silently no-op (effort/permission/model control_requests) left no trace
  // to debug. `ok:false` rows record the swallowed engine error.
  const logControl = (
    op: string,
    tabId: string,
    detail: Record<string, unknown>,
  ): void => {
    if (!logging) return;
    try {
      logging.writeBatch([{
        timestamp: new Date().toISOString(),
        level: detail.ok === false ? 'error' : 'info',
        source: 'claude-sdk',
        category: 'session-control',
        message: `session control: ${op} (tab ${tabId})`,
        metadata: JSON.stringify({ event: 'session.control', op, tab_id: tabId, ...detail }),
      }]);
    } catch (err) {
      console.error('[sessions] control logging failed:', err);
    }
  };

  function liveEngine(tabId: string): SessionHandle | null {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    return handle;
  }

  async function interrupt(tabId: string): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) return;
    try {
      await handle.engine.interrupt();
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
    if (!handle) {
      logControl('set_model', tabId, { ok: false, reason: 'no-live-engine', model });
      return;
    }
    try {
      const res = await handle.engine.sendControlRequest('set_model', { model });
      logControl('set_model', tabId, { ok: true, model, response: res ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] setModel failed for tab ${tabId}:`, err);
      logControl('set_model', tabId, { ok: false, model, error: msg });
    }
  }

  /**
   * Rename the session. The CLI persists this as a `custom-title` record and
   * lets it outrank the `ai-title` it generated for itself, so this is what
   * makes a rename official — verified end to end against CLI 2.1.273, which
   * answered `{subtype:'success'}` and wrote the record to the transcript.
   *
   * `source: 'host'` is the CLI's own term for a rename made in the hosting
   * application, which is what OmniFex is.
   *
   * Alone among the passthroughs here, this one reports back. The others can
   * afford to no-op quietly because the next turn shows whether the model or
   * mode changed; a rename that silently did nothing would leave the pencil
   * looking like it worked while the session kept its old name.
   */
  async function setTitle(tabId: string, title: string): Promise<boolean> {
    // The CLI reads an empty custom title as "clear the rename", dropping the
    // session back to its generated name. Never what the pencil meant.
    const trimmed = title.trim();
    if (!trimmed) {
      logControl('rename_session', tabId, { ok: false, reason: 'blank-title' });
      return false;
    }
    const handle = liveEngine(tabId);
    if (!handle) {
      logControl('rename_session', tabId, { ok: false, reason: 'no-live-engine', title: trimmed });
      return false;
    }
    try {
      const res = await handle.engine.sendControlRequest('rename_session', {
        title: trimmed,
        source: 'host',
      });
      logControl('rename_session', tabId, { ok: true, title: trimmed, response: res ?? null });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] setTitle failed for tab ${tabId}:`, err);
      logControl('rename_session', tabId, { ok: false, title: trimmed, error: msg });
      return false;
    }
  }

  /**
   * Ask the CLI to propose a name for this session, from `description`
   * (the first prompt), WITHOUT persisting it — `persist: false` makes the
   * CLI return the title and write nothing. The user saves it through
   * `setTitle` if they want it. Naming is on demand by design: the CLI
   * stopped auto-naming stdin-driven sessions in 2.1.277, and nothing here
   * spends a model call the user did not ask for.
   */
  async function suggestTitle(tabId: string, description: string): Promise<string | null> {
    const trimmed = description.trim();
    if (!trimmed) {
      logControl('generate_session_title', tabId, { ok: false, reason: 'blank-description' });
      return null;
    }
    const handle = liveEngine(tabId);
    if (!handle) {
      logControl('generate_session_title', tabId, { ok: false, reason: 'no-live-engine' });
      return null;
    }
    try {
      const res = await handle.engine.sendControlRequest<{ title?: unknown }>('generate_session_title', {
        description: trimmed,
        persist: false,
      });
      const title = typeof res?.title === 'string' ? res.title.trim() : '';
      logControl('generate_session_title', tabId, { ok: true, title: title || null, response: res ?? null });
      return title || null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] suggestTitle failed for tab ${tabId}:`, err);
      logControl('generate_session_title', tabId, { ok: false, error: msg });
      return null;
    }
  }

  async function setPermissionMode(tabId: string, mode: PermissionMode): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) {
      logControl('set_permission_mode', tabId, { ok: false, reason: 'no-live-engine', mode });
      return;
    }
    handle.permissionMode = mode;
    try {
      const res = await handle.engine.sendControlRequest('set_permission_mode', { mode });
      logControl('set_permission_mode', tabId, { ok: true, mode, response: res ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] setPermissionMode failed for tab ${tabId}:`, err);
      logControl('set_permission_mode', tabId, { ok: false, mode, error: msg });
    }
  }

  async function setEffort(
    tabId: string,
    level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null,
  ): Promise<void> {
    const handle = liveEngine(tabId);
    if (!handle) {
      logControl('set_effort', tabId, { ok: false, reason: 'no-live-engine', level });
      return;
    }
    try {
      const res = await handle.engine.sendControlRequest('apply_flag_settings', {
        settings: { effortLevel: level ?? undefined },
      });
      logControl('set_effort', tabId, { ok: true, level, response: res ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] setEffort failed for tab ${tabId}:`, err);
      logControl('set_effort', tabId, { ok: false, level, error: msg });
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
      await handle.engine.sendControlRequest('apply_flag_settings', {
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
      await handle.engine.sendControlRequest('set_max_thinking_tokens', {
        max_thinking_tokens: value,
      });
    } catch (err) {
      console.error(`[sessions] setThinking failed for tab ${tabId}:`, err);
    }
  }

  async function getAccountInfo(tabId: string): Promise<AccountInfo | null> {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    const init = handle.engine.getInitData();
    return (init?.account as AccountInfo | undefined) ?? null;
  }

  async function getContextUsage(
    tabId: string,
  ): Promise<CliControlGetContextUsageResponse | null> {
    const handle = liveEngine(tabId);
    if (!handle) return null;
    try {
      return await handle.engine.sendControlRequest<CliControlGetContextUsageResponse>(
        'get_context_usage',
      );
    } catch (err) {
      console.error(`[sessions] getContextUsage failed for tab ${tabId}:`, err);
      return null;
    }
  }

  /**
   * The session's LIVE permission rules, straight from the CLI.
   *
   * This is the read-back half of `applyPermissions`. That method pushes a
   * file-derived allow/deny union into the session and has no way to confirm
   * what the session ended up with; `permissions-io.ts` reads only `allow` and
   * `deny` out of three settings files, so `ask` rules, policy/managed rules,
   * `--allowedTools` grants and session-only approvals are all invisible to
   * the panel. The CLI knows all of them.
   *
   * Read-only by contract ("this request never changes rules"), so it is safe
   * to call on every panel open.
   *
   * `null` means "no answer" and NEVER "no rules" — the caller must fall back
   * to the file-derived view. Two ways to get it: a CLI older than 2.1.269
   * (answers "list_permission_rules is not available on this connection"), or
   * a malformed envelope.
   */
  async function listPermissionRules(
    tabId: string,
  ): Promise<CliPermissionRulesState | null> {
    const handle = liveEngine(tabId);
    if (!handle) return null;
    try {
      const res = await handle.engine.sendControlRequest<{
        state?: CliPermissionRulesState;
      }>('list_permission_rules');
      return res?.state ?? null;
    } catch (err) {
      console.error(`[sessions] listPermissionRules failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getSupportedCommands(tabId: string): Promise<SlashCommand[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    const init = handle.engine.getInitData();
    return (init?.commands as SlashCommand[] | undefined) ?? [];
  }

  async function getSupportedModels(tabId: string): Promise<ModelInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    const init = handle.engine.getInitData();
    return (init?.models as ModelInfo[] | undefined) ?? [];
  }

  async function getSupportedAgents(tabId: string): Promise<AgentInfo[]> {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    const init = handle.engine.getInitData();
    return (init?.agents as AgentInfo[] | undefined) ?? [];
  }

  async function getMcpServerStatus(tabId: string): Promise<McpServerStatus[]> {
    const handle = liveEngine(tabId);
    if (!handle) return [];
    try {
      const result = await Promise.race([
        handle.engine.sendControlRequest<{ mcpServers: McpServerStatus[] }>('mcp_status'),
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
        handle.engine.sendControlRequest<{ plugins: unknown[] }>('reload_plugins'),
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
    setTitle,
    suggestTitle,
    setPermissionMode,
    setEffort,
    applyPermissions,
    listPermissionRules,
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
