/**
 * What each protocol method does, in terms of the existing sessions service.
 *
 * The daemon's one structural trick lives here: the protocol's `sessionId` IS
 * the sessions service's `tabId`. `lifecycle.start({ tabId: id,
 * resumeSessionId: id })` pins the CLI's session UUID to the id we chose, and
 * `hasTranscript()` picks `--resume` or `--session-id` from what is on disk.
 * From then on every `sendToRenderer('<prefix>:<tabId>', …)` the service
 * emits already names the session, and the bridge does the rest.
 *
 * Nothing here knows about sockets. A handler receives typed params and a
 * `ClientContext`, returns a result or throws a `ProtocolError`-shaped object;
 * `server.ts` turns those into responses.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import type {
  ErrorCode,
  Project,
  ProtocolError,
  SessionSummary,
} from '../../src/protocol';
import type { ProtocolHandlers } from '../../src/protocol/interfaces';
import type { SessionsService, SessionStartParams } from '../services/sessions/types';
import type { SessionBridge } from './bridge';
import type { ProjectRegistry } from './projects';
import type { SessionLog, SessionMeta } from './session-log';

/** The IPC handler-map shape (`getHandlerMap()` in `electron/ipc/handlers.ts`). */
export type RpcHandler = (event: unknown, params?: Record<string, unknown>) => Promise<unknown>;

export interface RemoteHandlerDeps {
  sessions: SessionsService;
  log: SessionLog;
  bridge: SessionBridge;
  projects: ProjectRegistry;
  rpc: {
    handlers: Record<string, RpcHandler>;
    allow: ReadonlySet<string>;
  };
  daemonVersion: string;
  capabilities?: Record<string, unknown>;
  newSessionId?: () => string;
  now?: () => string;
}

export interface RemoteHandlers extends ProtocolHandlers {
  /** Every known session as a list-view snapshot — also the `/api/sessions` body. */
  summaries(): SessionSummary[];
  summary(sessionId: string): SessionSummary | null;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function protocolError(code: ErrorCode, message: string): ProtocolError {
  return { code, message };
}

/** `[CODE] message` is how the IPC layer encodes a structured error. */
const CODE_PREFIX_RE = /^\[([A-Z][A-Z0-9_]+)\]\s*/;
const KNOWN_CODES = new Set<string>([
  'MALFORMED_MESSAGE',
  'PROTOCOL_VERSION_MISMATCH',
  'NOT_FOUND',
  'NO_ACCOUNT_FOR_PROJECT',
  'SESSION_NOT_RUNNING',
  'PERMISSION_NOT_PENDING',
  'CHANNEL_NOT_ALLOWED',
  'INTERNAL',
]);

/**
 * Lift an IPC-era error into a protocol one. A recognised `[CODE]` prefix
 * keeps its code (`NO_ACCOUNT_FOR_PROJECT` is the one the renderer already
 * branches on); anything else is INTERNAL but keeps its message — the daemon
 * serves one user on their own tailnet, and "list_projects: ENOENT" is more
 * use to them than "rpc.invoke failed".
 */
export function rpcErrorToProtocol(err: unknown): ProtocolError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = CODE_PREFIX_RE.exec(raw);
  if (m && KNOWN_CODES.has(m[1])) {
    return { code: m[1] as ErrorCode, message: raw.slice(m[0].length) };
  }
  return { code: 'INTERNAL', message: raw };
}

export function createRemoteHandlers(deps: RemoteHandlerDeps): RemoteHandlers {
  const newId = deps.newSessionId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());

  function summaryOf(meta: SessionMeta): SessionSummary {
    const state = deps.bridge.state(meta.sessionId);
    const pending = deps.bridge.pendingPermissions(meta.sessionId);
    const active = deps.sessions.isActive(meta.sessionId);
    const sessionStatus = active ? (state?.sessionStatus ?? 'starting') : 'stopped';
    return {
      sessionId: meta.sessionId,
      projectId: meta.projectId,
      ...(meta.title !== undefined && { title: meta.title }),
      agent: meta.agent,
      mode: state?.mode ?? meta.mode,
      sessionStatus,
      ...(state?.model !== undefined && { model: state.model }),
      ...(state?.permissionMode !== undefined && { permissionMode: state.permissionMode }),
      lastSeq: deps.log.lastSeq(meta.sessionId),
      pendingPermissions: pending.length,
      // Advisory: a live process with something waiting on the user. The
      // subscribed client derives the real answer from the transcript.
      inFlight: active && pending.length > 0,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  }

  function requireMeta(sessionId: string): SessionMeta {
    const meta = deps.log.meta(sessionId);
    if (!meta) throw protocolError('NOT_FOUND', `no session ${sessionId}`);
    return meta;
  }

  function requireProject(projectId: string): Project {
    const p = deps.projects.get(projectId);
    if (!p) throw protocolError('NOT_FOUND', `no project ${projectId}`);
    return p;
  }

  /** Build the service's start params from persisted meta. Shared by create and resume. */
  function startParams(meta: SessionMeta): SessionStartParams {
    const o = meta.options as Partial<SessionStartParams> & { model?: string; permissionMode?: string };
    return {
      tabId: meta.sessionId,
      // Canonical for the same reason the registry is (see projects.ts):
      // hasTranscript() must look where the CLI actually wrote.
      projectPath: canonical(meta.projectPath),
      configDir: meta.configDir,
      // 'default' makes the engine omit --model; the CLI then obeys settings.json.
      model: o.model ?? 'default',
      permissionMode: o.permissionMode ?? 'default',
      // Pin the CLI's UUID to ours. On a fresh session hasTranscript() is
      // false and the engine spawns with --session-id; on a real resume it is
      // true and the engine spawns with --resume.
      resumeSessionId: meta.sessionId,
      ...(o.effort && { effort: o.effort }),
      ...(o.thinking && { thinking: o.thinking }),
      ...(o.mode && { mode: o.mode }),
      ...(o.manualAccountOverride !== undefined && { manualAccountOverride: o.manualAccountOverride }),
      agent: meta.agent,
    };
  }

  async function start(meta: SessionMeta): Promise<void> {
    deps.log.open(meta);
    await deps.sessions.start(startParams(meta));
  }

  const handlers: RemoteHandlers = {
    hello: () => ({
      protocolVersion: 1,
      daemonVersion: deps.daemonVersion,
      capabilities: deps.capabilities ?? {},
    }),

    // ---------------------------------------------------------------- projects
    'project.list': () => deps.projects.list(),
    'project.add': (p) => {
      try {
        return deps.projects.add(p.path, p.title);
      } catch (err) {
        throw protocolError('MALFORMED_MESSAGE', err instanceof Error ? err.message : String(err));
      }
    },
    'project.remove': (p) => {
      if (!deps.projects.remove(p.projectId)) throw protocolError('NOT_FOUND', `no project ${p.projectId}`);
    },

    // ---------------------------------------------------------------- sessions
    'session.list': (p) =>
      deps.log
        .list()
        .filter((m) => !p.projectId || m.projectId === p.projectId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map(summaryOf),

    'session.create': async (p) => {
      const project = requireProject(p.projectId);
      const options = (p.options ?? {}) as Record<string, unknown>;
      // The client may carry an explicit account choice (the desktop picker's
      // manual override) as options.configDir; otherwise the project's
      // resolved account is the only acceptable answer. No default account.
      const configDir =
        (typeof options.configDir === 'string' && options.configDir) || project.configDir || null;
      if (!configDir) {
        throw protocolError(
          'NO_ACCOUNT_FOR_PROJECT',
          `no account resolves ${project.path}; pick one and pass options.configDir`,
        );
      }
      const agent = options.agent === 'codex' ? 'codex' : 'claude';
      const mode = options.mode === 'tui' ? 'tui' : 'rich';
      const stamp = now();
      const meta: SessionMeta = {
        sessionId: (options.resumeSessionId as string | undefined) ?? newId(),
        projectId: project.projectId,
        projectPath: project.path,
        configDir,
        agent,
        mode,
        ...(p.title && { title: p.title }),
        options: { ...options, configDir },
        createdAt: stamp,
        updatedAt: stamp,
      };
      await start(meta);
      return summaryOf(meta);
    },

    'session.resume': async (p) => {
      const meta = requireMeta(p.sessionId);
      // Already live: re-attaching is a no-op on the process, the client
      // just subscribes. Otherwise wake the persisted session.
      if (!deps.sessions.isActive(meta.sessionId)) {
        deps.bridge.forget(meta.sessionId);
        await start(meta);
      }
      return summaryOf(deps.log.updateMeta(meta.sessionId, {}));
    },

    'session.kill': (p) => {
      requireMeta(p.sessionId);
      const wasActive = deps.sessions.isActive(p.sessionId);
      deps.sessions.stop(p.sessionId);
      // `stop()` deletes the handle before the engine exits, and runtime.ts
      // then suppresses the exit's status event as "handle replaced". Nothing
      // downstream would ever learn the session ended, so say it here — the
      // same two frames the renderer expects on a user stop.
      if (wasActive) {
        deps.bridge.sendToRenderer(`session-status:${p.sessionId}`, { sessionStatus: 'stopped' });
        deps.bridge.sendToRenderer(`agent-complete:${p.sessionId}`);
      }
    },

    'session.subscribe': (p, ctx) => {
      requireMeta(p.sessionId);
      ctx.subscribe(p.sessionId);
      const lastSeq = deps.log.lastSeq(p.sessionId);
      // Omitted fromSeq means "live from here"; a number means "everything
      // after it", which for a cold client is 0.
      if (p.fromSeq === undefined) return { fromSeq: lastSeq, lastSeq };
      for (const push of deps.log.replay(p.sessionId, p.fromSeq)) ctx.send(push);
      return { fromSeq: p.fromSeq, lastSeq };
    },

    'session.unsubscribe': (p, ctx) => {
      ctx.unsubscribe(p.sessionId);
    },

    // ------------------------------------------------------------------- turns
    'turn.send': (p) => {
      requireMeta(p.sessionId);
      if (!deps.sessions.isActive(p.sessionId)) {
        throw protocolError('SESSION_NOT_RUNNING', `session ${p.sessionId} has no live process; resume it first`);
      }
      const blocks: Record<string, unknown>[] =
        typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : [...p.content];
      // Bytes become the same base64 image blocks the desktop composer
      // builds; the CLI reads them off stdin, no file involved.
      for (const a of p.attachments ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: a.mimeType, data: a.dataBase64 },
        });
      }
      const onlyText = blocks.length === 1 && blocks[0].type === 'text' && typeof blocks[0].text === 'string';
      if (onlyText) deps.sessions.sendMessage(p.sessionId, blocks[0].text as string);
      else deps.sessions.sendStructuredMessage(p.sessionId, blocks);
      deps.log.updateMeta(p.sessionId, {});
    },

    'turn.interrupt': async (p) => {
      requireMeta(p.sessionId);
      if (!deps.sessions.isActive(p.sessionId)) {
        throw protocolError('SESSION_NOT_RUNNING', `session ${p.sessionId} has no live process`);
      }
      await deps.sessions.interrupt(p.sessionId);
    },

    // ------------------------------------------------------------- permissions
    'permission.respond': (p) => {
      requireMeta(p.sessionId);
      const ok = deps.sessions.respondPermission(
        p.sessionId,
        p.decision,
        p.updatedInput,
        p.remember as Parameters<SessionsService['respondPermission']>[3],
        p.permissionId,
      );
      if (!ok) {
        throw protocolError('PERMISSION_NOT_PENDING', `permission ${p.permissionId} is not pending on ${p.sessionId}`);
      }
      deps.bridge.permissionAnswered(p.sessionId, p.permissionId);
    },

    // ----------------------------------------------------------------- history
    'history.get': (p) => {
      requireMeta(p.sessionId);
      return deps.log.history(p.sessionId, { beforeSeq: p.beforeSeq, limit: p.limit });
    },

    // --------------------------------------------------------------------- rpc
    'rpc.invoke': async (p) => {
      if (!deps.rpc.allow.has(p.channel)) {
        throw protocolError('CHANNEL_NOT_ALLOWED', `${p.channel} is not exposed over the protocol`);
      }
      const handler = deps.rpc.handlers[p.channel];
      if (!handler) throw protocolError('NOT_FOUND', `no handler for ${p.channel}`);
      try {
        return await handler(null, p.params);
      } catch (err) {
        throw rpcErrorToProtocol(err);
      }
    },

    summaries: () => deps.log.list().map(summaryOf),
    summary: (id) => {
      const meta = deps.log.meta(id);
      return meta ? summaryOf(meta) : null;
    },
  };

  return handlers;
}
