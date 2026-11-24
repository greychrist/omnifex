// Sessions module — public re-exports
// Extracted from daemon/services/sessions.ts (pure refactor)

export { createSessionsService } from './lifecycle';
export type { SessionsService, SessionStartParams, SessionStatus } from './types';
