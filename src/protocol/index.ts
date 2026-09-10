/**
 * OmniFex Remote protocol — the only shared vocabulary between the daemon and
 * its clients.
 *
 * Lives in `src/` rather than a `packages/` workspace because this repo is a
 * single package and already has the precedent: `electron/services/usage.ts`
 * and friends import pure TypeScript out of `src/lib/`. The daemon reaches it
 * the same way (`../../src/protocol`), the renderer as `@/protocol`, and
 * vitest resolves both. Introducing a workspace root to hold one folder would
 * buy nothing and would move every build config.
 *
 * Nothing here may import Electron, Node, React or the DOM: this module is
 * loaded by the main process, the renderer, and a plain-Node test runner.
 */
export { PROTOCOL_VERSION } from './version';

export {
  // Schemas
  ClientMessageSchema,
  ServerMessageSchema,
  ProjectSchema,
  SessionSummarySchema,
  SessionOptionsSchema,
  SessionStatusSchema,
  SessionModeSchema,
  AgentKindSchema,
  AttachmentSchema,
  PermissionUpdateSchema,
  ProtocolErrorSchema,
  ErrorCodeSchema,
  EventKindSchema,
  SeqSchema,
  // Constants
  CLIENT_METHODS,
  SESSION_SCOPED_PUSHES,
  // Decoders
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
