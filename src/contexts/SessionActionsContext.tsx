import { createContext, useContext } from 'react';

/**
 * What a transcript card may ask its session to do. Provided by AgentSession
 * with stable callbacks, so reading it re-renders only the cards that use it —
 * not every StreamMessage, which a prop threaded through ClaudeTranscript
 * would. Null outside a live Claude session (history views, tests), and a
 * card then renders without actions.
 */
export interface SessionActions {
  projectPath: string;
  homeDir: string;
  permissionMode: string;
  /** Send a prompt exactly as if the user had typed it. */
  sendPrompt(text: string): void;
  /**
   * Add an allow rule to the project's `.claude/settings.local.json`. The CLI
   * re-reads settings files mid-session (verified 2.1.284), so the rule
   * applies to the running session as well as later ones.
   */
  addAllowRule(rule: string): Promise<void>;
  setPermissionMode(mode: string): void;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

export const SessionActionsProvider = SessionActionsContext.Provider;

export function useSessionActions(): SessionActions | null {
  return useContext(SessionActionsContext);
}
