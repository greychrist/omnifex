/**
 * The protocol speaks OmniFex concepts, never CLI flags or shapes. The one exception: a `transcript` event's payload is the renderer's `JsonlNode`, `raw` included.
 * Schemas are loose so a newer peer's unknown fields survive a parse; enums are closed.
 */
import { z } from 'zod';

import { PROTOCOL_VERSION } from './version';

/** The connection axis only: no idle/running here, conversation state is derived client-side. */
export const SessionStatusSchema = z.enum(['starting', 'started', 'error', 'stopped']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const AgentKindSchema = z.enum(['claude', 'codex']);

export const ClientKindSchema = z.enum(['desktop', 'web']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/** Owned by the session; a client never infers a turn from the transcript. */
export const TurnStateSchema = z.looseObject({
  status: z.enum(['idle', 'running']),
  since: z.string().nullable(),
});
export type TurnState = z.infer<typeof TurnStateSchema>;

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
  'CHANNEL_NOT_ALLOWED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ProtocolErrorSchema = z.looseObject({
  code: ErrorCodeSchema,
  message: z.string(),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

/** `accountId`/`configDir` null means unresolved: the client asks. */
export const ProjectSchema = z.looseObject({
  projectId: z.string(),
  path: z.string(),
  title: z.string().optional(),
  accountId: z.number().int().nullable().optional(),
  configDir: z.string().nullable().optional(),
  engine: AgentKindSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** `inFlight` = turn running OR a pending permission. */
export const SessionSummarySchema = z.looseObject({
  sessionId: z.string(),
  projectId: z.string(),
  title: z.string().optional(),
  agent: AgentKindSchema,
  sessionStatus: SessionStatusSchema,
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  lastSeq: z.number().int().nonnegative(),
  pendingPermissions: z.number().int().nonnegative(),
  inFlight: z.boolean(),
  /** `session.list` only: the other subscribed clients' kinds. */
  openIn: z.array(ClientKindSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionOptionsSchema = z.looseObject({
  agent: AgentKindSchema.optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  effort: z.string().optional(),
  resumeSessionId: z.string().optional(),
  /** The user picked an account explicitly; skip path-rule re-resolution. */
  manualAccountOverride: z.boolean().optional(),
});

/** Bytes, never a path: an iPad shares no filesystem with the CLI. */
export const AttachmentSchema = z.strictObject({
  name: z.string(),
  mimeType: z.string(),
  dataBase64: z.string(),
});

/** Only `addRules` is modelled; anything else passes through, or an unknown suggestion breaks the Allow button. */
export const PermissionUpdateSchema = z.union([
  z.looseObject({
    type: z.literal('addRules'),
    rules: z.array(z.looseObject({ toolName: z.string(), ruleContent: z.string().optional() })),
    behavior: z.literal('allow'),
    destination: z.enum(['session', 'projectSettings', 'userSettings', 'localSettings']),
  }),
  z.looseObject({ type: z.string() }),
]);

export const EventKindSchema = z.enum([
  /** A classified `JsonlNode`, `raw` included. */
  'transcript',
  'account-mismatch',
  /** A non-fatal CLI stderr line. Surfaced, never a status change. */
  'stderr',
  'notification',
  'init',
  'complete',
  'elicitation',
  'permission-withdrawn',
]);

const req = { requestId: z.string() };

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.looseObject({
    ...req,
    type: z.literal('hello'),
    clientId: z.string(),
    clientKind: ClientKindSchema,
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
  /** The daemon stops the session only if no other client still has it open. */
  z.looseObject({ ...req, type: z.literal('session.release'), sessionId: z.string() }),

  /** `fromSeq`: last seq held; omitted means live only. When the ring cannot answer, the result carries `resync: true`. */
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

  /** Addressed by `permissionId`: with two clients, answering the queue head could approve a tool the user never saw. */
  z.looseObject({
    ...req,
    type: z.literal('permission.respond'),
    sessionId: z.string(),
    permissionId: z.string(),
    decision: z.enum(['allow', 'deny']),
    updatedInput: z.looseObject({}).optional(),
    remember: z.array(PermissionUpdateSchema).optional(),
  }),

  /** The allowlist is enforced server-side; hiding UI on the client is not a boundary. */
  z.looseObject({ ...req, type: z.literal('rpc.invoke'), channel: z.string(), params: z.looseObject({}).optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const CLIENT_METHODS = [
  'hello',
  'project.list',
  'project.add',
  'project.remove',
  'session.list',
  'session.create',
  'session.resume',
  'session.kill',
  'session.release',
  'session.subscribe',
  'session.unsubscribe',
  'turn.send',
  'turn.interrupt',
  'permission.respond',
  'rpc.invoke',
] as const;
export type ClientMethod = (typeof CLIENT_METHODS)[number];

/** Split on `ok` so a failure with no error body cannot parse. */
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
    /** Seqs are per daemon run: a changed bootId means drop every seq and reload. */
    bootId: z.string().optional(),
    capabilities: z.looseObject({}).optional(),
  }),

  z.looseObject({ type: z.literal('project.changed'), projects: z.array(ProjectSchema) }),
  z.looseObject({ type: z.literal('session.changed'), sessions: z.array(SessionSummarySchema) }),

  z.looseObject({
    type: z.literal('session.state'),
    sessionId: z.string(),
    seq: SeqSchema,
    sessionStatus: SessionStatusSchema,
    agent: AgentKindSchema,
    turn: TurnStateSchema,
    error: z.string().optional(),
  }),

  z.looseObject({
    type: z.literal('event'),
    sessionId: z.string(),
    seq: SeqSchema,
    kind: EventKindSchema,
    payload: z.unknown(),
    /** Engine output and JSONL-tailed rows stay on separate renderer channels. */
    origin: z.enum(['engine', 'tail']).optional(),
    /** The legacy IPC channel to re-emit on. */
    channel: z.string().optional(),
  }),

  /** A non-session broadcast, verbatim under its legacy channel name. */
  z.looseObject({
    type: z.literal('channel'),
    channel: z.string(),
    payload: z.unknown(),
  }),

  z.looseObject({
    type: z.literal('permission.request'),
    sessionId: z.string(),
    seq: SeqSchema,
    permissionId: z.string(),
    tool: z.string(),
    input: z.looseObject({}),
    suggestions: z.array(PermissionUpdateSchema).optional(),
    toolUseId: z.string().optional(),
    kind: z.enum(['tool', 'patch', 'exec']).optional(),
    /** The renderer's permission-card payload, verbatim. */
    payload: z.unknown().optional(),
  }),

  /** Out-of-band failure. `requestId` is absent when nothing was being answered. */
  z.looseObject({
    type: z.literal('error'),
    requestId: z.string().optional(),
    code: ErrorCodeSchema,
    message: z.string(),
  }),
]);

export const ServerMessageSchema = z.union([ResponseSchema, ServerPushSchema]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** One shared counter, so a `fromSeq` replay restores status and open permissions, not just transcript rows. */
export const SESSION_SCOPED_PUSHES = ['session.state', 'event', 'permission.request'] as const;
export type SessionScopedPushType = (typeof SESSION_SCOPED_PUSHES)[number];
export type SessionScopedPush = Extract<ServerMessage, { type: SessionScopedPushType }>;

export type DecodeResult<T> = { ok: true; message: T } | { ok: false; error: ProtocolError };

function decode<T>(schema: z.ZodType<T>, raw: unknown): DecodeResult<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, message: parsed.data };
  return {
    ok: false,
    error: { code: 'MALFORMED_MESSAGE', message: z.prettifyError(parsed.error) },
  };
}

/** Never throws: an exception would drop every session on the socket. */
export function decodeClientMessage(raw: unknown): DecodeResult<ClientMessage> {
  return decode(ClientMessageSchema, raw);
}

export function decodeServerMessage(raw: unknown): DecodeResult<ServerMessage> {
  return decode(ServerMessageSchema, raw);
}

export { PROTOCOL_VERSION };
