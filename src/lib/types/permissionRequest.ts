/**
 * Canonical shape of a pending permission request inside the renderer.
 *
 * The main process sends the wire payload as snake_case (it lives on the
 * SDK stream as a `permission_request` message). The renderer normalises
 * it to this camelCase shape at the boundary (the session stream
 * reducer) and every downstream consumer — `usePermissions` hook,
 * `PermissionCard`, `ClaudeCodeSession` — uses the same type.
 *
 * The payload covers three permission kinds:
 *
 * - `'tool'` (default; Claude): `toolName` / `toolInput` / `suggestions`
 *   carry the SDK's `canUseTool` payload. The PermissionCard renders the
 *   tool-name preview + suggestion rule editor.
 * - `'patch'` (Codex): the `payload` field carries the raw
 *   `applyPatchApproval` params (fileChanges, reason, callId,
 *   conversationId). The dialog renders a per-file diff preview.
 * - `'exec'` (Codex): the `payload` field carries the raw
 *   `execCommandApproval` params (command, cwd, reason). The dialog
 *   renders a shell-command preview.
 *
 * `kind` defaults to `'tool'` so legacy Claude requests continue to work
 * without any wire-format change.
 */
export interface PermissionRequestPayload {
  requestId: string;
  /** Permission kind. Omitted (treated as `'tool'`) on Claude tool prompts. */
  kind?: 'tool' | 'patch' | 'exec';
  // ---- Claude tool fields (always populated for kind='tool') -----------
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions: PermissionSuggestion[];
  // ---- Codex-specific fields (populated for kind='patch' / 'exec') -----
  /** Which engine emitted the request. Defaults to `'claude'` historically. */
  agent?: 'claude' | 'codex';
  /** One-line human summary the engine computed (used for notifications). */
  summary?: string;
  /**
   * Raw `applyPatchApproval` / `execCommandApproval` params from the Codex
   * JSON-RPC server-request. Shape varies by build — consumers should
   * shape-probe defensively (same pattern as `ApplyPatchItem`).
   */
  payload?: unknown;
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
