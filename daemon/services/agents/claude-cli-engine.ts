import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildClaudeEnv } from '../util/claude-env';
import { createAssistantResolver } from './assistantMeta';
import { createControlRequestRegistry } from './control-request-registry';
import type {
  AgentEngine,
  ControlRequestOptions,
  AgentElicitationRequest,
  AgentEngineExit,
  AgentMessage,
  AgentPermissionRequest,
  AgentStartParams,
  Disposable,
  ElicitationAction,
  InitData,
} from './types';

export interface CreateClaudeCliEngineParams {
  tabId: string;
  claudeBinaryPath: string;
}

/** argv `--permission-mode` accepts only these; 'auto'/'dontAsk' there make the CLI exit 1, so they go via set_permission_mode after spawn. */
/** Any other value draws a stderr warning, so omit the flag; omitting it is what OmniFex's `auto` means. */
const CLI_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const CLI_ARGV_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

/**
 * Only what is true of the renderer; style rules belong in the user's CLAUDE.md.
 * The CLI snapshots the system prompt, so resumed sessions pick up changes only after compaction.
 */
export const OMNIFEX_SYSTEM_PROMPT_APPENDIX =
  'You are running inside OmniFex, a desktop client for Claude Code. ' +
  'OmniFex renders ```mermaid fenced code blocks as diagrams the user can expand full screen, ' +
  'pan, zoom, and export as SVG or PNG. When a process, flow, architecture, state machine or ' +
  'data model is easier to understand as a picture, illustrate it with a ```mermaid block. ' +
  'For bold or italic text in a node label, use a markdown string such as A["`**Title**\n*detail*`"], ' +
  'not HTML tags: labels are drawn as SVG text, which prints <b> and <i> literally.';

/**
 * `--verbose` is required with stream-json output (the CLI exits 1 otherwise).
 * Without `--setting-sources` the CLI runs isolated: no CLAUDE.md, project settings or skills.
 */
function buildArgs(p: AgentStartParams): string[] {
  const args: string[] = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Subagent frames carry parent_tool_use_id; derivation, cost and filters must exclude them from the main chain.
    '--forward-subagent-text',
    '--permission-prompt-tool', 'stdio',
    '--setting-sources', 'user,project,local',
    '--append-system-prompt', OMNIFEX_SYSTEM_PROMPT_APPENDIX,
  ];
  if (p.resume) {
    args.push('--resume', p.sessionId);
  } else {
    args.push('--session-id', p.sessionId);
  }
  if (p.model && p.model !== 'default') {
    args.push('--model', p.model);
  }
  if (p.permissionMode && CLI_ARGV_PERMISSION_MODES.has(p.permissionMode)) {
    args.push('--permission-mode', p.permissionMode);
  }
  // Sent on resume too, so the session runs the level the picker shows.
  if (p.effort && CLI_EFFORT_LEVELS.has(p.effort)) {
    args.push('--effort', p.effort);
  }
  if (p.allowedTools && p.allowedTools.length > 0) {
    args.push('--allowed-tools', p.allowedTools.join(','));
  }
  return args;
}

function toElicitationRequest(requestId: string, r: Record<string, unknown>): AgentElicitationRequest {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const out: AgentElicitationRequest = {
    requestId,
    serverName: str(r.mcp_server_name) ?? 'MCP server',
    message: str(r.message) ?? '',
    mode: r.mode === 'url' ? 'url' : 'form',
  };
  const optional: [keyof AgentElicitationRequest, string | Record<string, unknown> | undefined][] = [
    ['url', str(r.url)],
    ['elicitationId', str(r.elicitation_id)],
    ['requestedSchema', r.requested_schema && typeof r.requested_schema === 'object'
      ? (r.requested_schema as Record<string, unknown>)
      : undefined],
    ['title', str(r.title)],
    ['displayName', str(r.display_name)],
    ['description', str(r.description)],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function createClaudeCliEngine(
  factory: CreateClaudeCliEngineParams,
): AgentEngine {
  let child: ChildProcessWithoutNullStreams | null = null;
  let sessionId: string | null = null;
  let initData: InitData | null = null;
  const messageCallbacks: ((m: AgentMessage) => void)[] = [];
  const permissionCallbacks: ((r: AgentPermissionRequest) => void)[] = [];
  const elicitationCallbacks: ((r: AgentElicitationRequest) => void)[] = [];
  const cancelCallbacks: ((requestId: string) => void)[] = [];
  const exitCallbacks: ((info: AgentEngineExit) => void)[] = [];
  const errorCallbacks: ((err: Error) => void)[] = [];
  const pendingControlRequests = createControlRequestRegistry();
  /** The CLI expects `toolUseID` echoed back in its PermissionResult. */
  const pendingPermissionToolUseIds = new Map<string, string>();
  const assistantResolver = createAssistantResolver();
  let nextRequestSeq = 1;
  let lineBuf = '';
  let stderrBuf = '';

  function emitMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }
    const _peek = payload as { type?: string; subtype?: string };
    const p = payload as {
      type?: string;
      subtype?: string;
      session_id?: string;
      request_id?: string;
      request?: {
        subtype?: string;
        tool_name?: string;
        tool_use_id?: string;
        input?: unknown;
      };
      response?: {
        subtype?: string;
        request_id?: string;
        response?: unknown;
        error?: string;
      };
    };

    if (p?.type === 'control_response' && p?.response?.request_id) {
      const id = p.response.request_id;
      if (p.response.subtype === 'error') {
        pendingControlRequests.fail(id, new Error(p.response.error ?? 'unknown control_response error'));
      } else {
        pendingControlRequests.settle(id, p.response.response);
      }
      return;
    }

    if (p?.type === 'control_request' && p?.request?.subtype === 'can_use_tool') {
      const requestId = String(p.request_id ?? '');
      const toolUseId = p.request.tool_use_id ?? '';
      if (requestId && toolUseId) {
        pendingPermissionToolUseIds.set(requestId, toolUseId);
      }
      const req: AgentPermissionRequest = {
        agent: 'claude',
        requestId,
        kind: 'tool',
        summary: `Permission requested for tool: ${p.request.tool_name ?? 'unknown'}`,
        payload: p.request,
      };
      for (const cb of permissionCallbacks) {
        try {
          cb(req);
        } catch {
          /* subscriber threw */
        }
      }
      return;
    }

    // The CLI parks the session until answered: route to the dialog, never the transcript.
    if (p?.type === 'control_request' && p?.request?.subtype === 'elicitation') {
      const req = toElicitationRequest(String(p.request_id ?? ''), p.request);
      for (const cb of elicitationCallbacks) {
        try {
          cb(req);
        } catch {
          /* subscriber threw */
        }
      }
      return;
    }

    // Fail undeclared capabilities now: unanswered parks the session, forwarded draws an Unrecognized-record card.
    if (p?.type === 'control_request') {
      const subtype = p.request?.subtype ?? 'unknown';
      void writeLine({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: String(p.request_id ?? ''),
          error: `OmniFex does not handle control_request subtype: ${subtype}`,
        },
      }).catch(() => { /* child gone — nothing is waiting any more */ });
      return;
    }

    if (p?.type === 'control_cancel_request') {
      const requestId = String(p.request_id ?? '');
      pendingPermissionToolUseIds.delete(requestId);
      for (const cb of cancelCallbacks) {
        try {
          cb(requestId);
        } catch {
          /* subscriber threw */
        }
      }
      return;
    }

    if (p?.type === 'system' && p?.subtype === 'init') {
      if (typeof p.session_id === 'string') sessionId = p.session_id;
      const init = payload as {
        account?: unknown;
        commands?: unknown[];
        models?: unknown[];
        agents?: unknown[];
        plugins?: unknown[];
        capabilities?: unknown;
      };
      initData = {
        account: init.account,
        commands: init.commands,
        models: init.models,
        agents: init.agents,
        plugins: init.plugins,
        capabilities: Array.isArray(init.capabilities)
          ? init.capabilities.filter((c): c is string => typeof c === 'string')
          : undefined,
      };
    }
    // The committed assistant frame arrives before the message_delta carrying its stop_reason and final usage; the resolver merges them.
    for (const forwarded of assistantResolver.resolve(payload)) {
      const msg: AgentMessage = {
        agent: 'claude',
        tabId: factory.tabId,
        receivedAt: new Date().toISOString(),
        sessionId,
        payload: forwarded,
      };
      for (const cb of messageCallbacks) {
        try {
          cb(msg);
        } catch {
          /* subscriber threw — swallow so one bad listener can't poison the rest */
        }
      }
    }
  }

  function wireStdout(stdout: NodeJS.ReadableStream): void {
    stdout.on('data', (chunk: Buffer | string) => {
      lineBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        emitMessage(line);
        nl = lineBuf.indexOf('\n');
      }
    });
  }

  function wireStderr(stderr: NodeJS.ReadableStream): void {
    stderr.on('data', (chunk: Buffer | string) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = stderrBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line) {
          const err = new Error(line);
          for (const cb of errorCallbacks) {
            try {
              cb(err);
            } catch {
              /* subscriber threw */
            }
          }
        }
        nl = stderrBuf.indexOf('\n');
      }
    });
  }

  /** Ready is the OS 'spawn' event: `system:init` arrives only mid-first-turn. */
  async function start(p: AgentStartParams): Promise<void> {
    if (child !== null) {
      // Detach before killing: the dying child's late 'exit' would tear down the restarted session on the same handle.
      const old = child;
      child = null;
      old.removeAllListeners('exit');
      old.removeAllListeners('error');
      try { old.stdout?.removeAllListeners(); } catch { /* ignore */ }
      try { old.stderr?.removeAllListeners(); } catch { /* ignore */ }
      try { old.kill('SIGTERM'); } catch { /* already gone */ }
    }
    lineBuf = '';
    stderrBuf = '';

    // Pinned at spawn, never derived from a wire message.
    sessionId = p.sessionId;

    const args = buildArgs(p);
    const spawned = spawn(factory.claudeBinaryPath, args, {
      cwd: p.projectPath,
      // CLAUDE_CODE_NOTIFICATIONS_HOST is interactive-only: buildClaudeEnv also feeds `claude -p`.
      // CLAUDE_CODE_ARTIFACT: sdk-cli sessions default it off. Before the spread, so an inherited `=0` wins.
      env: {
        CLAUDE_CODE_ARTIFACT: '1',
        ...buildClaudeEnv(p.configDir),
        CLAUDE_CODE_NOTIFICATIONS_HOST: '1',
      },
    });
    child = spawned;

    wireStdout(spawned.stdout);
    wireStderr(spawned.stderr);

    spawned.on('error', (err: Error) => {
      for (const cb of errorCallbacks) {
        try { cb(err); } catch { /* swallow */ }
      }
    });

    spawned.on('exit', (code, signal) => {
      const info: AgentEngineExit = { code: code ?? -1, signal };
      pendingControlRequests.failAll(
        new Error(`control_request aborted: engine exited (code ${code ?? -1}${signal ? `, signal ${signal}` : ''})`),
      );
      for (const cb of exitCallbacks) {
        try { cb(info); } catch { /* swallow */ }
      }
    });

    await new Promise<void>((resolve, reject) => {
      const childRef = spawned;
      const onSpawn = (): void => {
        childRef.off('error', onErr);
        resolve();
      };
      const onErr = (err: Error): void => {
        childRef.off('spawn', onSpawn);
        reject(err);
      };
      childRef.once('spawn', onSpawn);
      childRef.once('error', onErr);
    });

    // Not awaited, so a CLI that refuses it never stalls a start. The summaries' spend is already priced from modelUsage.
    void sendControlRequest('initialize', { agentProgressSummaries: true })
      .catch(() => { /* an older CLI sends no summaries */ });

    // The default display streams only token counts. No max_thinking_tokens key, so the budget is untouched. Not awaited.
    void sendControlRequest('set_max_thinking_tokens', { thinking_display: 'summarized' })
      .catch(() => { /* an older CLI keeps its default display */ });
  }

  async function applyExtendedPermissionMode(mode: string): Promise<void> {
    if (CLI_ARGV_PERMISSION_MODES.has(mode)) return;
    try {
      await sendControlRequest('set_permission_mode', { mode });
    } catch {
      // Non-fatal — CLI keeps whatever mode it defaulted to.
    }
  }

  async function writeUserMessage(content: unknown): Promise<void> {
    if (!child?.stdin.writable) {
      throw new Error('ClaudeCliEngine.send: child not running');
    }
    const payload = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: sessionId ?? '',
      // Must stamp {kind:'human'}: an unstamped prompt fails the CLI's isHuman() gates and gets no ai-title.
      origin: { kind: 'human' },
    };
    const line = JSON.stringify(payload) + '\n';
    const stdin = child.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async function send(text: string): Promise<void> {
    await writeUserMessage([{ type: 'text', text }]);
  }

  async function sendStructured(content: unknown[]): Promise<void> {
    await writeUserMessage(content);
  }

  async function respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    payload?: unknown,
  ): Promise<void> {
    if (!child?.stdin.writable) return;
    const toolUseId = pendingPermissionToolUseIds.get(requestId) ?? '';
    pendingPermissionToolUseIds.delete(requestId);

    const permissionResult: Record<string, unknown> = {
      behavior: decision,
      toolUseID: toolUseId,
    };
    if (payload && typeof payload === 'object') {
      Object.assign(permissionResult, payload as Record<string, unknown>);
      // After the spread, so the payload cannot clobber them.
      permissionResult.behavior = decision;
      permissionResult.toolUseID = toolUseId;
    }

    const envelope = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: permissionResult,
      },
    };
    const line = JSON.stringify(envelope) + '\n';
    const stdin = child.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function writeLine(envelope: unknown): Promise<void> {
    if (!child?.stdin.writable) return Promise.resolve();
    const stdin = child.stdin;
    return new Promise<void>((resolve, reject) => {
      stdin.write(JSON.stringify(envelope) + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function respondElicitation(
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
  ): Promise<void> {
    await writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: action === 'accept' && content ? { action, content } : { action },
      },
    });
  }

  function sendControlRequest<T = unknown>(
    subtype: string,
    params?: Record<string, unknown>,
    opts?: ControlRequestOptions,
  ): Promise<T> {
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('ClaudeCliEngine.sendControlRequest: child not running'));
    }
    const requestId = `req-${nextRequestSeq++}-${Date.now().toString(36)}`;
    const envelope = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype, ...(params ?? {}) },
    };
    const line = JSON.stringify(envelope) + '\n';
    const promise = pendingControlRequests.create<T>(requestId, subtype, opts?.timeoutMs);
    child.stdin.write(line, (err) => {
      if (err) pendingControlRequests.fail(requestId, err);
    });
    // Reject locally too: the CLI's reply to a cancel is an error not worth waiting for.
    const signal = opts?.signal;
    if (signal) {
      const onAbort = () => {
        if (child?.stdin.writable) {
          child.stdin.write(JSON.stringify({ type: 'control_cancel_request', request_id: requestId }) + '\n', () => {});
        }
        pendingControlRequests.fail(requestId, new Error(`control_request '${subtype}' cancelled`));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return promise;
  }

  async function interrupt(): Promise<void> {
    await sendControlRequest('interrupt');
  }

  async function close(): Promise<void> {
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      child = null;
    }
  }

  function kill(): void {
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      child = null;
    }
  }

  function getResumeId(): string | null {
    return sessionId;
  }

  function getInitData(): InitData | null {
    return initData;
  }

  function onMessage(cb: (m: AgentMessage) => void): Disposable {
    messageCallbacks.push(cb);
    return {
      dispose() {
        const i = messageCallbacks.indexOf(cb);
        if (i !== -1) messageCallbacks.splice(i, 1);
      },
    };
  }
  function onPermissionRequest(cb: (r: AgentPermissionRequest) => void): Disposable {
    permissionCallbacks.push(cb);
    return {
      dispose() {
        const i = permissionCallbacks.indexOf(cb);
        if (i !== -1) permissionCallbacks.splice(i, 1);
      },
    };
  }
  function onElicitationRequest(cb: (r: AgentElicitationRequest) => void): Disposable {
    elicitationCallbacks.push(cb);
    return {
      dispose() {
        const i = elicitationCallbacks.indexOf(cb);
        if (i !== -1) elicitationCallbacks.splice(i, 1);
      },
    };
  }
  function onControlCancel(cb: (requestId: string) => void): Disposable {
    cancelCallbacks.push(cb);
    return {
      dispose() {
        const i = cancelCallbacks.indexOf(cb);
        if (i !== -1) cancelCallbacks.splice(i, 1);
      },
    };
  }
  function onError(cb: (err: Error) => void): Disposable {
    errorCallbacks.push(cb);
    return {
      dispose() {
        const i = errorCallbacks.indexOf(cb);
        if (i !== -1) errorCallbacks.splice(i, 1);
      },
    };
  }
  function onExit(cb: (info: AgentEngineExit) => void): Disposable {
    exitCallbacks.push(cb);
    return {
      dispose() {
        const i = exitCallbacks.indexOf(cb);
        if (i !== -1) exitCallbacks.splice(i, 1);
      },
    };
  }

  return {
    kind: 'claude',
    start,
    applyExtendedPermissionMode,
    send,
    sendStructured,
    sendControlRequest,
    respondPermission,
    respondElicitation,
    interrupt,
    close,
    kill,
    getResumeId,
    getInitData,
    onMessage,
    onPermissionRequest,
    onElicitationRequest,
    onControlCancel,
    onError,
    onExit,
  };
}
