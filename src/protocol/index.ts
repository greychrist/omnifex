/** Imported by the daemon, the renderer and plain-Node tests: never import Node, React or the DOM here. */
export { PROTOCOL_VERSION } from './version';

export {
  ClientMessageSchema,
  ServerMessageSchema,
  ProjectSchema,
  SessionSummarySchema,
  SessionOptionsSchema,
  SessionStatusSchema,
  TurnStateSchema,
  AgentKindSchema,
  ClientKindSchema,
  AttachmentSchema,
  PermissionUpdateSchema,
  ProtocolErrorSchema,
  ErrorCodeSchema,
  EventKindSchema,
  SeqSchema,
  CLIENT_METHODS,
  SESSION_SCOPED_PUSHES,
  decodeClientMessage,
  decodeServerMessage,
} from './messages';

export type {
  ClientMessage,
  ClientMethod,
  ServerMessage,
  SessionScopedPush,
  SessionScopedPushType,
  Project,
  SessionSummary,
  SessionStatus,
  ClientKind,
  ProtocolError,
  ErrorCode,
  DecodeResult,
} from './messages';

export type {
  ProtocolClient,
  ProtocolServer,
  ProtocolHandlers,
  ClientContext,
  ConnectionState,
  Unsubscribe,
  ParamsOf,
  ResultOf,
  ProtocolRequestMap,
} from './interfaces';
