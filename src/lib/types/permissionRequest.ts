/**
 * Canonical shape of a pending permission request inside the renderer.
 *
 * The main process sends the wire payload as snake_case (it lives on the
 * SDK stream as a `permission_request` message). The renderer normalises
 * it to this camelCase shape at the boundary (the session stream
 * reducer) and every downstream consumer — `usePermissions` hook,
 * `PermissionCard`, `ClaudeCodeSession` — uses the same type.
 */
export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions: PermissionSuggestion[];
}

/**
 * One suggestion entry inside `PermissionRequestPayload.suggestions`.
 *
 * Mirrors the SDK's PermissionUpdate shape. `destination: 'session'` is
 * the in-memory variant (rule applies to the running query only); the
 * three settings destinations also persist the rule to disk.
 */
export interface PermissionSuggestion {
  type: 'addRules';
  rules: { toolName: string; ruleContent?: string }[];
  behavior: 'allow' | 'deny';
  destination: 'session' | 'projectSettings' | 'userSettings' | 'localSettings';
}
