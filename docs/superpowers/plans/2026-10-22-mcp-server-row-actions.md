# MCP Server Row Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `⋯` menu on each row of the Session context panel's MCP section offering Authenticate, Re-authenticate, and Enable/Disable — the three terminal `/mcp` actions chat mode cannot reach today.

**Architecture:** Each action is a CLI control request the live session already accepts (`mcp_authenticate`, `mcp_clear_auth`, `mcp_toggle`, verified in the 2.1.307 binary). Three session-query methods send them; three invoke channels expose them; the renderer gates menu items with a pure function that mirrors the CLI's own `/mcp` menu gating, opens the returned `authUrl` with `platform.openExternal`, and polls `mcp_status` until the server's status moves. The CLI runs the OAuth localhost callback listener and reconnects the server itself — OmniFex never touches tokens.

**Tech Stack:** Electron main (sessions service), React 19 + Radix `dropdown-menu`, Vitest.

**Spec:** none — this plan is the spec. Evidence is the 2.1.307 binary (`~/.local/share/claude/versions/2.1.307`) and the conversation of 2026-10-22.

## Global Constraints

- Control request shapes (SDK client in the binary, verbatim):
  - `{subtype:"mcp_authenticate", serverName, redirectUri?}` → success payload `{authUrl?, requiresUserAction, callbackExpected, redirectScheme?, state?, callbackPort?}`. Omit `redirectUri`: the CLI then uses its localhost listener.
  - `{subtype:"mcp_clear_auth", serverName}` → success, no payload. HTTP/SSE servers only; errors with `Cannot clear auth for server type …` otherwise.
  - `{subtype:"mcp_toggle", serverName, enabled: boolean}` → success, no payload.
- `mcp_authenticate` resolves only after OAuth discovery/registration produces a URL — pass `{ timeoutMs: 60_000 }`, not the registry's 10 s default. The other two use the default.
- CLI errors propagate as thrown `Error`s with the CLI's message (the `setPermissionMode` pattern in `queries.ts`), never as `false` — the row shows the message.
- Every request is logged with `logControl(subtype, tabId, {...})` like its neighbours.
- New channels are **not** native-only: the daemon owns the session. Opening the browser happens in the renderer via `platform.openExternal` (`src/lib/platform.ts`), which is already native-routed.
- `daemon.ts` and `main.ts` adapter bags change together (root CLAUDE.md, "Change both, or neither").
- Menu-item gating mirrors the CLI's `/mcp` menu (binary, `Qe.push({label:…})` block):
  - `disabled` → **Enable** only.
  - otherwise → **Disable** always.
  - OAuth-capable (`config.type` is `http` or `sse`, or the server is a claude.ai connector): `needs-auth` → **Authenticate**; `connected` → **Re-authenticate** (HTTP/SSE only — the CLI offers no re-auth for claude.ai connectors).
  - stdio servers get no auth items.

## Review Focus

1. **A claude.ai connector** (`claude.ai Atlassian` etc.): `callbackExpected:false`, sign-in finishes on claude.ai and the CLI may not notice. Expect the row to keep polling, then stop at the timeout with "Still waiting — reopen the panel after signing in" rather than spin forever. Test in Task 4.
2. **The iPad / browser client:** `window.open` sends the user to an OAuth page whose redirect targets `localhost:<callbackPort>` *on the iPad*, which fails. Expect Authenticate/Re-authenticate to be hidden when `!platform.isElectron` (`src/lib/platform.ts`) — pass that as `canOpenBrowserCallback` — not offered and broken. Test in Task 4.
3. **User closes the browser tab without signing in:** expect polling to stop at 180 s and the row to return to its normal state with the same hint as (1); a second Authenticate must work (the CLI replaces the pending flow). Test in Task 4 (timeout path).
4. **Session not live** (transcript-only tab, or stopped): expect an error "Session is not running", not a silent no-op. Test in Task 2.
5. **Two clicks in a row** on the same row while a request is in flight: expect the menu trigger disabled until it settles. Test in Task 4.

---

### Task 1: Confirm CLI behaviour the plan cannot see in the binary

No code. Records facts the later tasks depend on into this plan file under a new `## Verified` heading.

- [ ] **Step 1:** With an account that has a `needs-auth` HTTP server and a claude.ai connector, start a throwaway `claude -p --input-format stream-json --output-format stream-json --verbose` process in a scratch dir and write `control_request` lines to its stdin (the OmniFex channels do not exist yet).
- [ ] **Step 2:** Record: (a) the `config.type` value `mcp_status` reports for a claude.ai connector; (b) whether `mcp_toggle {enabled:false}` persists to settings (`disabledMcpServers` or similar in `.claude.json`) or is session-only; (c) the full `mcp_authenticate` payload for both server kinds; (d) whether `mcp_status` moves `needs-auth → connected` on its own after the browser flow.
- [ ] **Step 3:** If (a) is not `claudeai-proxy`, fix the predicate in Task 3's constraints. If (b) is session-only, the Disable item's label becomes "Disable for this session". If (d) is false, Task 4 calls `mcp_reconnect` after the poll — add it to Task 2.
- [ ] **Step 4:** Commit the plan update: `git commit -m "docs(plan): record verified mcp control-request behaviour"`.

### Task 2: Session-query methods + IPC wiring

**Files:**
- Modify: `electron/services/sessions/queries.ts` (next to `getMcpServerStatus`, ~line 511; add to the returned object ~line 597)
- Modify: `electron/services/sessions/types.ts:384` (interface)
- Modify: `electron/ipc/handlers.ts:110` (interface) and `:566` (handler map)
- Modify: `electron/ipc/channels.ts:112` (`INVOKE_CHANNELS`)
- Modify: `electron/main.ts:1378`, `electron/remote/daemon.ts:699` (adapter bags)
- Modify: `electron/__tests__/ipc-handlers.test.ts:184` (channel list)
- Test: `electron/__tests__/sessions-queries.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export interface McpAuthResult { authUrl: string | null; requiresUserAction: boolean; callbackExpected: boolean }
  mcpAuthenticate(tabId: string, serverName: string): Promise<McpAuthResult>;
  mcpReauthenticate(tabId: string, serverName: string): Promise<McpAuthResult>; // clear_auth, then authenticate
  mcpSetEnabled(tabId: string, serverName: string, enabled: boolean): Promise<void>;
  ```
- Produces channels: `session_mcp_authenticate`, `session_mcp_reauthenticate`, `session_mcp_set_enabled` — params `{ tabId, serverName, enabled? }`, accepting `session_id` / `server_name` aliases.

- [ ] **Step 1: Write failing tests** in a new `describe('mcp server actions')` using the file's `createEngine({ control })` fixture:
  - `mcpAuthenticate sends mcp_authenticate with serverName and a 60 s timeout` — `calls[0]` equals `{subtype:'mcp_authenticate', payload:{serverName:'atlassian'}}`; `sendControlRequest.mock.calls[0][2]` matches `{timeoutMs: 60_000}`.
  - `mcpAuthenticate normalises the payload` — control returns `{authUrl:'https://x', requiresUserAction:true, callbackExpected:true, callbackPort:5555}` → resolves `{authUrl:'https://x', requiresUserAction:true, callbackExpected:true}`; control returns `{requiresUserAction:false, callbackExpected:false}` → `authUrl: null`.
  - `mcpReauthenticate clears auth before authenticating` — `calls.map(c => c.subtype)` equals `['mcp_clear_auth','mcp_authenticate']`.
  - `mcpReauthenticate does not authenticate when clear_auth fails` — control throws on `mcp_clear_auth`; rejects with that message; one call only.
  - `mcpSetEnabled sends mcp_toggle` — payload `{serverName:'github', enabled:false}`.
  - `rejects with "Session is not running" when no live engine` — for all three (Review Focus 4).
  - `rethrows the CLI's error message` — control throws `Error('Server not found: x')` → rejects with that message.
- [ ] **Step 2:** `npx vitest run electron/__tests__/sessions-queries.test.ts` → the new tests FAIL (`q.mcpAuthenticate is not a function`).
- [ ] **Step 3:** Implement the three methods in `queries.ts` following `setPermissionMode`'s try/log/rethrow shape; `liveEngine(tabId)` null → `throw new Error('Session is not running')`.
- [ ] **Step 4:** Wire channels, handler map (`wrapWith`, both param spellings), both adapter bags, and the `ipc-handlers.test.ts` list.
- [ ] **Step 5:** `npx vitest run electron/__tests__/sessions-queries.test.ts electron/__tests__/ipc-channel-contract.test.ts electron/__tests__/ipc-handlers.test.ts electron/__tests__/remote-rpc-allowlist.test.ts` → PASS. `npm run check` → PASS.
- [ ] **Step 6: Commit** `feat(sessions): mcp authenticate / reauthenticate / enable control requests`.

### Task 3: Menu-item gating

**Files:**
- Create: `src/lib/mcpServerActions.ts`
- Test: `src/lib/__tests__/mcpServerActions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type McpServerAction = 'authenticate' | 'reauthenticate' | 'enable' | 'disable';
  export function mcpServerActions(server: SessionMcpServerStatus, opts: { canOpenBrowserCallback: boolean }): McpServerAction[];
  ```

- [ ] **Step 1: Write failing tests**, one per Global Constraints gating line, with `canOpenBrowserCallback: true`:
  - disabled stdio → `['enable']`; disabled http → `['enable']`.
  - connected stdio → `['disable']`.
  - needs-auth http → `['authenticate','disable']`; needs-auth sse → same.
  - connected http → `['reauthenticate','disable']`.
  - needs-auth claude.ai connector → `['authenticate','disable']`; connected claude.ai connector → `['disable']`.
  - failed http → `['disable']`.
  - `canOpenBrowserCallback: false` on needs-auth http → `['disable']` (Review Focus 2).
- [ ] **Step 2:** `npx vitest run src/lib/__tests__/mcpServerActions.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement. Connector detection uses the value recorded in Task 1(a).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat(mcp): gate server row actions like the CLI's /mcp menu`.

### Task 4: `⋯` menu, auth flow and status polling

**Files:**
- Create: `src/components/sessionContext/McpServerActionsMenu.tsx`
- Modify: `src/components/SessionMCPStatus.tsx` (row button, ~line 70; new props)
- Modify: `src/hooks/useSessionMcpStatus.ts` (add `watchUntil`)
- Modify: `src/lib/api.ts:2034` (three wrappers)
- Modify: `src/components/AgentSession.tsx:3115` (pass `tabId`, `watchUntil`)
- Test: `src/components/__tests__/SessionMCPStatus.test.tsx`, `src/hooks/__tests__/useSessionMcpStatus.test.tsx`

**Interfaces:**
- Consumes: `mcpServerActions` (Task 3); `api.sessionMcpAuthenticate(tabId, serverName)`, `api.sessionMcpReauthenticate(tabId, serverName)` → `McpAuthResult`, `api.sessionMcpSetEnabled(tabId, serverName, enabled)` → `void` (add these to `api.ts`, `McpAuthResult` mirrored there).
- Produces:
  - `useSessionMcpStatus` returns additionally `watchUntil(serverName: string, done: (s: SessionMcpServerStatus | undefined) => boolean, timeoutMs = 180_000): Promise<boolean>` — polls `sessionMcpServerStatus` every `pollMs`, updates `servers` each tick, resolves `true` when `done` holds, `false` at timeout or unmount.
  - `SessionMCPStatus` props gain `tabId: string` and `watchUntil` (same signature).

- [ ] **Step 1: Write failing hook tests** (fake timers): `watchUntil resolves true once the server leaves needs-auth`; `watchUntil resolves false after timeoutMs` (Review Focus 3).
- [ ] **Step 2: Write failing component tests** (mock `@/lib/api` and `@/lib/platform`):
  - `shows a ⋯ menu with the gated actions` — needs-auth http row → menu lists "Authenticate" and "Disable".
  - `Authenticate opens the auth URL and watches the server` — `platform.openExternal` called with `'https://x'`; `watchUntil` called with `'atlassian'`.
  - `shows the CLI's error under the row when an action fails` — api rejects `Error('Server not found: x')` → that text visible.
  - `Disable calls set_enabled(false) and refreshes` — then `watchUntil` called with a predicate that holds for `status === 'disabled'`.
  - `shows a still-waiting hint when the watch times out` — `watchUntil` resolves `false` → text "Still waiting — reopen the panel after signing in" (Review Focus 1, 3).
  - `disables the ⋯ trigger while an action is in flight` (Review Focus 5).
  - `hides auth items in the web client` — mocked `platform.isElectron === false` → no "Authenticate" (Review Focus 2).
- [ ] **Step 3:** `npx vitest run src/components/__tests__/SessionMCPStatus.test.tsx src/hooks/__tests__/useSessionMcpStatus.test.tsx` → new tests FAIL.
- [ ] **Step 4:** Implement. The `⋯` trigger (`MoreHorizontal` icon) sits at the row's right edge as a sibling of the expand `<button>`, not inside it (no nested buttons); it renders only when `mcpServerActions` returns items. Menu uses `src/components/ui/dropdown-menu.tsx`. Per-row state: `busy`, `error`, `waiting`. When `authUrl` is null and `requiresUserAction` is false, skip the browser and go straight to `watchUntil`.
- [ ] **Step 5:** Same command → PASS. Run `npm run check`.
- [ ] **Step 6: Commit** `feat(mcp): ⋯ menu with authenticate, re-authenticate, enable/disable on MCP rows`.

### Task 5: Verify and exercise for real

- [ ] **Step 1:** `bash .claude/skills/verify/scripts/verify.sh` (check, build, test:coverage, rebuild:electron) → all pass. Tee output to a log.
- [ ] **Step 2:** `npm run package`; Greg launches the packaged build himself (no `npm start` — never spawn dev instances). Exercise: authenticate a `needs-auth` HTTP server, re-authenticate a connected one, disable and re-enable one, authenticate a claude.ai connector. Record outcomes in this plan under `## Verified`.
