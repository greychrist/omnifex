// Sessions module — SDK options factory
// Extracted from lifecycle.ts: assembles the @anthropic-ai/claude-agent-sdk
// query options for a session start. Excludes `canUseTool` because that
// callback closes over the session handle (which is created after this
// factory runs); the caller injects it post-handle.

import { discoverWorktrees } from '../git-worktrees';
import { createSessionHooks } from './hooks';
import { findSystemClaudeBinary } from './binary';
import { buildClaudeEnv } from '../util/claude-env';
import type {
  SessionStartParams,
  SendToRenderer,
  NotificationHooks,
  LoggingService,
  ElicitationDecision,
} from './types';

// Re-export for backward compat with anything outside this module that
// already imported `findSystemClaudeBinary` from factory.
export { findSystemClaudeBinary } from './binary';

export interface BuildSdkOptionsDeps {
  tabId: string;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
  logging: LoggingService | null;
  /**
   * Called when the SDK requests an elicitation. The factory wires this
   * into options.onElicitation; the caller (start()) supplies the
   * resolver registration (which writes to handle.elicitationResolver).
   */
  onElicitationRequest: (request: any) => Promise<ElicitationDecision>;
  /**
   * Polled by the stderr closure to decide whether to demote the SDK's
   * own teardown noise (cli.js hook_9 firing during close → "Stream
   * closed") to debug. lifecycle.stop() owns the underlying state and
   * keeps it valid past the sessions-map deletion so late-arriving
   * stderr from the dying subprocess still resolves to true. Optional:
   * tests that don't exercise the shutdown path can omit it.
   */
  isShuttingDown?: () => boolean;
}

/**
 * Build the SDK query options object for a session start.
 *
 * Returns options *minus* `canUseTool` — that callback needs to close
 * over the SessionHandle (permissionQueue, status), which is created
 * after this factory runs. The caller assigns canUseTool after.
 */
export function buildSdkOptions(
  params: SessionStartParams,
  deps: BuildSdkOptionsDeps,
): Record<string, unknown> {
  const { tabId, sendToRenderer, notificationHooks, logging, onElicitationRequest, isShuttingDown } = deps;
  const { projectPath, configDir, model, permissionMode, resumeSessionId, effort, thinking } = params;

  const options: Record<string, unknown> = {
    cwd: projectPath,
    model,
    permissionMode: permissionMode,
    // Routed through buildClaudeEnv so an empty / ~/.claude-resolving
    // configDir throws here instead of silently spawning a subprocess that
    // dumps state into the user's default ~/.claude.
    env: buildClaudeEnv(configDir),
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
    // Stream periodic AI-generated progress summaries for running subagents
    // (Task tool) on `task_progress` system messages. Without this the SDK
    // emits only task_started + task_notification, leaving the SubagentBar
    // expander empty mid-run.
    agentProgressSummaries: true,
    // Stream token-level partial assistant messages so the renderer can paint
    // assistant text as Claude generates it (rendered into the inflight slot
    // via src/lib/inflightCoalescer.ts). Subagent partials and non-text deltas
    // are filtered renderer-side; this flag is the single switch.
    includePartialMessages: true,
    // Elicitation: prompt the user via the renderer instead of auto-accepting.
    onElicitation: async (request: any) => {
      // URL mode: open browser immediately, then wait for user decision
      if (request.mode === 'url' && request.url) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy load; only needed when an elicitation requests a URL.
          const { shell } = require('electron') as typeof import('electron');
          shell.openExternal(request.url).catch((err: unknown) => { console.error('[factory:elicitation-open-external]', err); });
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

      return onElicitationRequest(request);
    },
  };

  if (permissionMode === 'bypassPermissions') {
    options.allowDangerouslySkipPermissions = true;
  }

  if (effort) {
    options.effort = effort;
  }
  if (thinking) {
    options.thinking = thinking;
  }

  // Admit sibling git worktrees into the SDK sandbox so a session rooted
  // at one checkout can touch files in related worktrees (e.g. Greg's
  // feature-branch worktrees under ~/Repos/personal/worktrees/<project>/).
  // Without this every cross-worktree write trips the "Path is outside
  // allowed working directories" dialog regardless of permissions.allow
  // rules. Discovery is fire-and-forget on failure (returns []).
  const siblingWorktrees = discoverWorktrees(projectPath);
  if (siblingWorktrees.length > 0) {
    options.additionalDirectories = siblingWorktrees;
    if (logging) {
      logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          source: 'claude-sdk',
          category: `session:${tabId}`,
          message: `admitting ${siblingWorktrees.length} sibling worktree${siblingWorktrees.length === 1 ? '' : 's'}`,
          metadata: JSON.stringify({ event: 'session.start.worktrees', paths: siblingWorktrees }),
        },
      ]);
    }
  }

  // Route CLI subprocess stderr into the logging service. Note the CLI routes its
  // own `--debug` output to ~/.claude-personal/debug/<sessionId>.txt (not stderr),
  // so this callback only catches unexpected stderr (crashes, fatal errors).
  if (logging) {
    // CLI-internal hook callbacks that fail with "Stream closed" — the CLI
    // fires a numbered hook (its own teardown / pending-tasks reminder)
    // that calls back via sendRequest, but the SDK input channel is already
    // closed. Under 0.2.x this surfaced as a single line at tab close
    // (`Error in hook callback hook_9: Stream closed`); under 0.3.x it
    // also fires once on every session start and the bun runtime dumps a
    // multi-line source-context block. No actionable signal either way —
    // demoted unconditionally so it never produces a red row or toast.
    const HOOK_CALLBACK_NOISE = /Error in hook callback hook_\d+/i;
    // Patterns that are benign during shutdown but real otherwise. When
    // the renderer closes a tab, lifecycle.stop() closes the SDK input
    // channel; any bare "Stream closed" stderr after that is part of the
    // teardown, not a crash.
    const TEARDOWN_NOISE = /Stream closed/i;
    // "Real error" patterns — surface even during shutdown so we don't hide
    // a genuine crash just because we asked the session to stop.
    const REAL_ERROR = /^error[:\s]|FATAL|panic/i;

    options.stderr = (data: string) => {
      const shuttingDown = isShuttingDown?.() === true;

      // Order matters:
      //   1. HOOK_CALLBACK_NOISE — always debug (CLI-internal, no actionable
      //      signal regardless of session state).
      //   2. TEARDOWN_NOISE — debug during shutdown only (a bare "Stream
      //      closed" outside the hook-callback wrapper is rare and we want
      //      to see it during normal operation).
      //   3. REAL_ERROR — anything matching /^error/ / FATAL / panic that
      //      survived the above filters surfaces as error level.
      let level: 'error' | 'debug';
      if (HOOK_CALLBACK_NOISE.test(data)) {
        level = 'debug';
      } else if (TEARDOWN_NOISE.test(data)) {
        level = shuttingDown ? 'debug' : 'error';
      } else if (REAL_ERROR.test(data)) {
        level = 'error';
      } else {
        level = 'debug';
      }

      logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level,
          source: 'claude-sdk',
          category: `session:${tabId}`,
          message: data,
        },
      ]);
    };
  }

  // Audit hooks — createSessionHooks handles null logging internally
  options.hooks = createSessionHooks(tabId, logging, sendToRenderer, notificationHooks);

  // Resolve the binary up front so the SDK doesn't fall back to its own
  // bundled copy when a system install is available. Fail fast with an
  // actionable message if neither a system install nor a bundled binary
  // is available — letting the SDK try its own resolution would surface
  // an opaque spawn error mid-stream after the user already paid the
  // session-start latency.
  const binaryPath = findSystemClaudeBinary();
  if (!binaryPath) {
    throw new Error(
      'Claude Code CLI binary not found. Install via ' +
      '`npm i -g @anthropic-ai/claude-code` (or place it at ' +
      '~/.local/bin/claude, /usr/local/bin/claude, or /opt/homebrew/bin/claude).',
    );
  }
  options.pathToClaudeCodeExecutable = binaryPath;

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  return options;
}
