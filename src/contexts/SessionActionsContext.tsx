import { createContext, useContext } from 'react';

/** A context, not a prop through ClaudeTranscript, so only the cards that use it re-render. Null outside a live session. */
export interface SessionActions {
  projectPath: string;
  homeDir: string;
  permissionMode: string;
  turnRunning: boolean;
  /** Queues at the head, and a prompt already in a held queue is taken out and sent now. */
  sendPrompt(text: string): void;
  /** The CLI re-reads settings files mid-session (verified 2.1.284), so the rule applies to the running session. */
  addAllowRule(rule: string): Promise<void>;
  setPermissionMode(mode: string): void;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

export const SessionActionsProvider = SessionActionsContext.Provider;

export function useSessionActions(): SessionActions | null {
  return useContext(SessionActionsContext);
}
