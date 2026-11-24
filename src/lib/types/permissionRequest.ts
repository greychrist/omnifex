/** Camel-cased at the stream reducer from the snake_case wire `permission_request`. `kind` omitted means `'tool'`. */
export interface PermissionRequestPayload {
  requestId: string;
  kind?: 'tool' | 'patch' | 'exec';
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** A symlink escape: no `Edit(...)` rule stops that ask, so the card grants these via `addDirectories`. */
  directoryGrant?: string[];
  suggestions: PermissionSuggestion[];
  /** The CLI refuses a persistent rule for this ask: offer allow-once / deny only. */
  suppressAlwaysAllowRule?: boolean;
  agent?: 'claude' | 'codex';
  summary?: string;
  /** Raw Codex approval params; shape varies by build, so probe defensively. */
  payload?: unknown;
}

export type PermissionSuggestion =
  | {
      type: 'addRules';
      rules: { toolName: string; ruleContent?: string }[];
      behavior: 'allow' | 'deny';
      destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
    }
  | {
      type: 'addDirectories';
      directories: string[];
      destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
    };

/** Only the card for the withdrawn request closes; a different one on screen is a newer ask. */
export function withoutWithdrawnPermission(
  current: PermissionRequestPayload | null,
  requestId: string,
): PermissionRequestPayload | null {
  return current?.requestId === requestId ? null : current;
}
