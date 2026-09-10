/**
 * OmniFex Remote — wire messages.
 *
 * The protocol carries OmniFex concepts, not Claude Code concepts: clients
 * speak in projects, sessions, turns and permissions, and never in CLI flags,
 * control-request subtypes or `--output-format` shapes. The daemon owns the
 * CLI; that is the whole point of the split, and it is why CLI churn should
 * only ever reach `electron/services/`.
 *
 * ONE DELIBERATE EXCEPTION, and it is load-bearing: `event.payload` for a
 * `transcript` event is the renderer's own `JsonlNode`, `raw` included. The
 * classifier (`src/lib/jsonlClassifier.ts`) and every consumer of it
 * (`StreamMessage.tsx` reads `message.raw.*` in dozens of places) already live
 * on the client side of this boundary. Re-deriving a CLI-free shape would mean
 * rewriting the whole render path before a single byte moved over a socket.
 * Purging `raw` is a later hardening pass, tracked as such — not an accident.
 *
 * Schemas are LOOSE objects on purpose. "Clients and daemon must tolerate
 * unknown fields" is the additive-versioning rule, so a newer peer's extra
 * field must survive a parse rather than be stripped or rejected. Closed
 * *enums* are the exception: an unknown `sessionStatus` is a bug, not a
 * feature (see `docs/session-lifecycle.md`).
 */
import { z } from 'zod';

import { PROTOCOL_VERSION } from './version';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * The connection axis, verbatim from `docs/session-lifecycle.md`.
 *
 * There is deliberately NO `idle` / `running` / `awaiting_permission` here.
 * Those are `conversationStatus`, which that document defines as *derived* on
 * the client from `messages[]` and never carried in a payload. Collapsing the
 * two axes into one enum is the exact mistake that produced the
 * "session stuck on starting" family of bugs, and `'waiting_permission'` was
 * removed from the old FSM for the same reason: an open permission keeps its
 * task entry open, which keeps the derivation at `running` on its own.
 *
 * Clients that need a single label compute it; the daemon does not invent one.
 */
export const SessionStatusSchema = z.enum(['starting', 'started', 'error', 'stopped']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionModeSchema = z.enum(['rich', 'tui']);
export const AgentKindSchema = z.enum(['claude', 'codex']);

/** Positive, monotonic per session, starting at 1. */
export const SeqSchema = z.number().int().positive();

export const ErrorCodeSchema = z.enum([
  'MALFORMED_MESSAGE',
  'PROTOCOL_VERSION_MISMATCH',
  'NOT_FOUND',
  /** Kept verbatim from the IPC era: `App.tsx` already branches on this code. */
  'NO_ACCOUNT_FOR_PROJECT',
  'SESSION_NOT_RUNNING',
  'PERMISSION_NOT_PENDING',
  /** `rpc.invoke` naming a channel the daemon's allowlist does not carry. */
  'CHANNEL_NOT_ALLOWED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ProtocolErrorSchema = z.looseObject({
  code: ErrorCodeSchema,
  message: z.string(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

/**
 * A project the daemon can spawn into.
 *
 * `accountId` / `configDir` are not decoration. Resolution order (explicit
 * override → longest path rule → unambiguous on-disk ownership → null) runs
 * against the account registry, and the spawn needs `CLAUDE_CONFIG_DIR`. A
 * registry entry of `{projectId, path, title}` alone could not start a
 * session on a multi-account machine. `null` means unresolved — the client is
 * expected to ask, exactly as the desktop account picker does today.
 */
export const ProjectSchema = z.looseObject({
  projectId: z.string(),
  path: z.string(),
  title: z.string().optional(),
  accountId: z.number().int().nullable().optional(),
  configDir: z.string().nullable().optional(),
  engine: AgentKindSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * List-view snapshot of a session.
 *
 * `inFlight` and `pendingPermissions` are an ADVISORY rollup for rendering a
 * list, where the client has no event stream to derive from. A client that is
 * subscribed derives the truth itself; these fields must never become the
 * source of truth for a session the client is watching.
 */
export const SessionSummarySchema = z.looseObject({
  sessionId: z.string(),
  projectId: z.string(),
  title: z.string().optional(),
  agent: AgentKindSchema,
  mode: SessionModeSchema,
  sessionStatus: SessionStatusSchema,
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  lastSeq: z.number().int().nonnegative(),
  pendingPermissions: z.number().int().nonnegative(),
  inFlight: z.boolean(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** Start options, mirroring what `session_start` accepts today. */
export const SessionOptionsSchema = z.looseObject({
  agent: AgentKindSchema.optional(),
  mode: SessionModeSchema.optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: z.string().optional(),
  thinking: z.looseObject({}).optional(),
  /** Adopt an existing CLI transcript instead of minting a new session id. */
  resumeSessionId: z.string().optional(),
  /** The user picked an account explicitly; skip path-rule re-resolution. */
  manualAccountOverride: z.boolean().optional(),
});

/**
 * Bytes, never a path.
 *
 * `save_pasted_image` writes a temp file and hands the CLI its path, which
 * works precisely because the renderer and the CLI share a filesystem. An iPad
 * shares nothing, so the wire shape has to be the bytes themselves — the
 * daemon is what lands them on disk for the CLI to read.
 */
export const AttachmentSchema = z.strictObject({
  name: z.string(),
  mimeType: z.string(),
  dataBase64: z.string(),
});

/**
 * Permission-rule suggestions to persist on "Allow & Remember".
 *
 * `addRules` is modelled because the rule editor drives it. Everything else
 * the CLI sends (`setMode`, `addDirectories`, and whatever it adds next) is
 * passed through unmodelled: refusing an unrecognised entry would break the
 * Allow button on a live session over a suggestion we merely did not know
 * about. See `withDefaultRuleSuggestion` in `sessions/permissions.ts`.
 */
export const PermissionUpdateSchema = z.union([
  z.looseObject({
    type: z.literal('addRules'),
    rules: z.array(z.looseObject({ toolName: z.string(), ruleContent: z.string().optional() })),
    behavior: z.literal('allow'),
    destination: z.enum(['session', 'projectSettings', 'userSettings', 'localSettings']),
  }),
  z.looseObject({ type: z.string() }),
]);

/** Kinds of session-scoped stream event. `payload` shape follows `kind`. */
export const EventKindSchema = z.enum([
  /** A classified `JsonlNode` — the transcript. Carries `raw`; see the note above. */
  'transcript',
  /** Model / permission-mode / effort the CLI is actually running. */
  'control-state',
  /** The resolved config dir is not signed in as the account we expected. */
  'account-mismatch',
  /** A non-fatal CLI stderr line. Surfaced, never a status change. */
  'stderr',
  /** Raw pty bytes. Electron-only: the web client is chat-mode. */
  'tui-data',
  /** Something the user should be told about out of band. */
  'notification',
]);

// ---------------------------------------------------------------------------
// Client → daemon
// ---------------------------------------------------------------------------

/** Present on every request so the daemon can echo it on the response. */
const req = { requestId: z.string() };

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.looseObject({
    ...req,
    type: z.literal('hello'),
    clientId: z.string(),
    clientKind: z.enum(['electron', 'web']),
    protocolVersion: z.number().int(),
  }),

  z.looseObject({ ...req, type: z.literal('project.list') }),
  z.looseObject({ ...req, type: z.literal('project.add'), path: z.string(), title: z.string().optional() }),
  z.looseObject({ ...req, type: z.literal('project.remove'), projectId: z.string() }),

  z.looseObject({ ...req, type: z.literal('session.list'), projectId: z.string().optional() }),
  z.looseObject({
    ...req,
    type: z.literal('session.create'),
    projectId: z.string(),
    title: z.string().optional(),
    options: SessionOptionsSchema.optional(),
  }),
  z.looseObject({ ...req, type: z.literal('session.resume'), sessionId: z.string() }),
  z.looseObject({ ...req, type: z.literal('session.kill'), sessionId: z.string() }),

  /**
   * `fromSeq` is the last seq the client already has. The daemon replays
   * everything after it from the ring buffer, then live-tails. Omitted means
   * "live only" — a fresh view that intends to page history separately.
   */
  z.looseObject({
    ...req,
    type: z.literal('session.subscribe'),
    sessionId: z.string(),
    fromSeq: z.number().int().nonnegative().optional(),
  }),
  z.looseObject({ ...req, type: z.literal('session.unsubscribe'), sessionId: z.string() }),

  z.looseObject({
    ...req,
    type: z.literal('turn.send'),
    sessionId: z.string(),
    content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
    attachments: z.array(AttachmentSchema).optional(),
  }),
  z.looseObject({ ...req, type: z.literal('turn.interrupt'), sessionId: z.string() }),

  /**
   * Addressed by `permissionId`, not by queue position.
   *
   * The desktop path shifts the head of `handle.permissionQueue`, which is
   * safe only because one window can click. With two clients subscribed to the
   * same session, an unaddressed response resolves whichever request happens
   * to be first — approving a tool the user never saw.
   */
  z.looseObject({
    ...req,
    type: z.literal('permission.respond'),
    sessionId: z.string(),
    permissionId: z.string(),
    decision: z.enum(['allow', 'deny']),
    updatedInput: z.looseObject({}).optional(),
    remember: z.array(PermissionUpdateSchema).optional(),
  }),

  z.looseObject({
    ...req,
    type: z.literal('history.get'),
    sessionId: z.string(),
    beforeSeq: z.number().int().positive().optional(),
    limit: z.number().int().positive(),
  }),

  /**
   * The escape hatch for the ~165 IPC channels that are not session workflow
   * (Brain, cost, usage, accounts, MCP and hooks editors, storage browser,
   * Lima). Typing each as its own message would be ~165 schemas that change
   * every time a channel does. The allowlist is enforced server-side — hiding
   * admin UI on the client is not a boundary.
   */
  z.looseObject({ ...req, type: z.literal('rpc.invoke'), channel: z.string(), params: z.looseObject({}).optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Every method name, for exhaustiveness checks on both sides. */
export const CLIENT_METHODS = [
  'hello',
  'project.list',
  'project.add',
  'project.remove',
  'session.list',
  'session.create',
  'session.resume',
  'session.kill',
  'session.subscribe',
  'session.unsubscribe',
  'turn.send',
  'turn.interrupt',
  'permission.respond',
  'history.get',
  'rpc.invoke',
] as const;
export type ClientMethod = (typeof CLIENT_METHODS)[number];

// ---------------------------------------------------------------------------
// Daemon → client
// ---------------------------------------------------------------------------

/**
 * Split on `ok` rather than carrying an optional error, so a failure with no
 * error body cannot parse: the client would otherwise reject its promise with
 * nothing to show the user.
 *
 * Its own union because a discriminated union keys on ONE field, and these two
 * share `type: 'response'` while differing on `ok`. Nesting keeps both
 * narrowings — `msg.type === 'response'` then `msg.ok === true` — which a
 * flat object plus a refinement would lose.
 */
export const ResponseSchema = z.discriminatedUnion('ok', [
  z.looseObject({ type: z.literal('response'), requestId: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.looseObject({
    type: z.literal('response'),
    requestId: z.string(),
    ok: z.literal(false),
    error: ProtocolErrorSchema,
  }),
]);

export const ServerPushSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('welcome'),
    protocolVersion: z.number().int(),
    daemonVersion: z.string(),
    capabilities: z.looseObject({}).optional(),
  }),

  z.looseObject({ type: z.literal('project.changed'), projects: z.array(ProjectSchema) }),
  z.looseObject({ type: z.literal('session.changed'), sessions: z.array(SessionSummarySchema) }),

  /**
   * The connection axis only. See `SessionStatusSchema` for why this does not
   * carry a conversation state.
   */
  z.looseObject({
    type: z.literal('session.state'),
    sessionId: z.string(),
    seq: SeqSchema,
    sessionStatus: SessionStatusSchema,
    mode: SessionModeSchema,
    agent: AgentKindSchema,
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    effort: z.string().optional(),
    error: z.string().optional(),
  }),

  z.looseObject({
    type: z.literal('event'),
    sessionId: z.string(),
    seq: SeqSchema,
    kind: EventKindSchema,
    payload: z.unknown(),
  }),

  z.looseObject({
    type: z.literal('permission.request'),
    sessionId: z.string(),
    seq: SeqSchema,
    permissionId: z.string(),
    tool: z.string(),
    input: z.looseObject({}),
    /** The CLI's own suggestions, plus our fallback rule, for the editor. */
    suggestions: z.array(PermissionUpdateSchema).optional(),
    toolUseId: z.string().optional(),
  }),

  /** Out-of-band failure. `requestId` is absent when nothing was being answered. */
  z.looseObject({
    type: z.literal('error'),
    requestId: z.string().optional(),
    code: ErrorCodeSchema,
    message: z.string(),
  }),
]);

/**
 * A plain union of the two groups: no `response` shape can match a push and no
 * push can match a response, so there is no ambiguity to order around.
 */
export const ServerMessageSchema = z.union([ResponseSchema, ServerPushSchema]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * Pushes that consume the per-session sequence space.
 *
 * All three share ONE counter so the ring buffer is a single ordered log: a
 * `session.subscribe { fromSeq }` replay then restores state transitions and
 * still-open permission requests, not just transcript rows. A reconnecting
 * iPad that replayed only transcript events would sit at a stale status with
 * an invisible permission prompt blocking the turn.
 */
export const SESSION_SCOPED_PUSHES = ['session.state', 'event', 'permission.request'] as const;
export type SessionScopedPushType = (typeof SESSION_SCOPED_PUSHES)[number];
export type SessionScopedPush = Extract<ServerMessage, { type: SessionScopedPushType }>;

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type DecodeResult<T> = { ok: true; message: T } | { ok: false; error: ProtocolError };

function decode<T>(schema: z.ZodType<T>, raw: unknown): DecodeResult<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  return {
    ok: false,
    error: { code: 'MALFORMED_MESSAGE', message: z.prettifyError(parsed.error) },
  };
}

/**
 * Never throws. A peer that can send a malformed frame can send one at any
 * time, and the daemon answering with a protocol `error` beats an exception
 * unwinding through the socket handler and dropping every session on it.
 */
export function decodeClientMessage(raw: unknown): DecodeResult<ClientMessage> {
  return decode(ClientMessageSchema, raw);
}

export function decodeServerMessage(raw: unknown): DecodeResult<ServerMessage> {
  return decode(ServerMessageSchema, raw);
}

export { PROTOCOL_VERSION };
