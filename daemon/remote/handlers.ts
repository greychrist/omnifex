// The protocol's `sessionId` IS the sessions service's `tabId`.
/* eslint-disable @typescript-eslint/only-throw-error -- handlers throw ProtocolError-shaped plain objects by contract; server.ts's isProtocolError turns them into the wire error frame, and callers compare them as plain objects. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import type {
  ClientKind,
  ErrorCode,
  Project,
  ProtocolError,
  SessionSummary,
} from '../../src/protocol';
import type { ClientContext, ProtocolHandlers } from '../../src/protocol/interfaces';
import type { SessionsService, SessionStartParams } from '../services/sessions/types';
import type { SessionBridge } from './bridge';
import type { ProjectRegistry } from './projects';
import type { SessionLog, SessionMeta } from './session-log';

export type RpcHandler = (event: unknown, params?: Record<string, unknown>) => Promise<unknown>;

export interface RemoteHandlerDeps {
  sessions: SessionsService;
  log: SessionLog;
  bridge: SessionBridge;
  projects: ProjectRegistry;
  viewers(sessionId: string): readonly ClientContext[];
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
      sessionStatus,
      ...(typeof meta.options.model === 'string' && { model: meta.options.model }),
      ...(typeof meta.options.permissionMode === 'string' && { permissionMode: meta.options.permissionMode }),
      lastSeq: deps.log.lastSeq(meta.sessionId),
      pendingPermissions: pending.length,
      inFlight: active && (deps.sessions.getTurn(meta.sessionId).status === 'running' || pending.length > 0),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  }

  function openElsewhere(sessionId: string, ctx: ClientContext): ClientKind[] {
    const kinds = new Set(deps.viewers(sessionId).filter((c) => c !== ctx).map((c) => c.clientKind));
    return [...kinds].sort();
  }

  function kill(sessionId: string): void {
    requireMeta(sessionId);
    const wasActive = deps.sessions.isActive(sessionId);
    deps.sessions.stop(sessionId);
    // `stop()` makes runtime.ts suppress the exit's status event, so announce the end here.
    if (wasActive) {
      deps.bridge.sendToRenderer(`session-status:${sessionId}`, { sessionStatus: 'stopped' });
      deps.bridge.sendToRenderer(`agent-complete:${sessionId}`);
    }
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

  function startParams(meta: SessionMeta): SessionStartParams {
    const o = meta.options as Partial<SessionStartParams> & { model?: string; permissionMode?: string };
    return {
      tabId: meta.sessionId,
      // Canonical: hasTranscript() must look where the CLI actually wrote.
      projectPath: canonical(meta.projectPath),
      configDir: meta.configDir,
      // 'default' makes the engine omit --model; the CLI then obeys settings.json.
      model: o.model ?? 'default',
      permissionMode: o.permissionMode ?? 'default',
      resumeSessionId: meta.sessionId,
      ...(o.effort && { effort: o.effort }),
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

    'session.list': (p, ctx) =>
      deps.log
        .list()
        .filter((m) => !p.projectId || m.projectId === p.projectId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((meta) => ({ ...summaryOf(meta), openIn: openElsewhere(meta.sessionId, ctx) })),

    'session.create': async (p) => {
      const project = requireProject(p.projectId);
      const options = (p.options ?? {});
      // An explicit client choice, else the resolved account; no default account.
      const configDir =
        (typeof options.configDir === 'string' && options.configDir) || project.configDir || null;
      if (!configDir) {
        throw protocolError(
          'NO_ACCOUNT_FOR_PROJECT',
          `no account resolves ${project.path}; pick one and pass options.configDir`,
        );
      }
      const agent = options.agent === 'codex' ? 'codex' : 'claude';
      const stamp = now();
      const meta: SessionMeta = {
        sessionId: (options.resumeSessionId as string | undefined) ?? newId(),
        projectId: project.projectId,
        projectPath: project.path,
        configDir,
        agent,
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
      if (!deps.sessions.isActive(meta.sessionId)) {
        deps.bridge.forget(meta.sessionId);
        await start(meta);
      }
      return summaryOf(deps.log.updateMeta(meta.sessionId, {}));
    },

    'session.kill': (p) => {
      kill(p.sessionId);
    },

    'session.release': (p, ctx) => {
      requireMeta(p.sessionId);
      ctx.unsubscribe(p.sessionId);
      if (deps.viewers(p.sessionId).some((c) => c !== ctx)) return { stopped: false };
      kill(p.sessionId);
      return { stopped: true };
    },

    'session.subscribe': (p, ctx) => {
      requireMeta(p.sessionId);
      ctx.subscribe(p.sessionId);
      const lastSeq = deps.log.lastSeq(p.sessionId);
      if (p.fromSeq === undefined) return { fromSeq: lastSeq, lastSeq };
      const pushes = deps.log.replay(p.sessionId, p.fromSeq);
      if (pushes === null) return { fromSeq: lastSeq, lastSeq, resync: true };
      for (const push of pushes) ctx.send(push);
      return { fromSeq: p.fromSeq, lastSeq };
    },

    'session.unsubscribe': (p, ctx) => {
      ctx.unsubscribe(p.sessionId);
    },

    'turn.send': (p) => {
      requireMeta(p.sessionId);
      if (!deps.sessions.isActive(p.sessionId)) {
        throw protocolError('SESSION_NOT_RUNNING', `session ${p.sessionId} has no live process; resume it first`);
      }
      const blocks: Record<string, unknown>[] =
        typeof p.content === 'string' ? [{ type: 'text', text: p.content }] : [...p.content];
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

    'rpc.invoke': async (p, ctx) => {
      if (!deps.rpc.allow.has(p.channel)) {
        throw protocolError('CHANNEL_NOT_ALLOWED', `${p.channel} is not exposed over the protocol`);
      }
      const handler = deps.rpc.handlers[p.channel];
      if (!handler) throw protocolError('NOT_FOUND', `no handler for ${p.channel}`);
      try {
        return await handler(ctx, p.params);
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
