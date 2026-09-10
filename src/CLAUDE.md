# CLAUDE.md — src (renderer)

React 19 + TypeScript + Tailwind v4 renderer for OmniFex, built with Vite. The renderer has no Node.js access.

The same bundle runs in two places: inside Electron, and in a browser served by the OmniFex Remote daemon. `src/lib/remote/bootstrap.ts` decides at boot what `window.electronAPI` is — the preload bridge, or a WebSocket shim onto the daemon that keeps the bridge for Electron-only channels. Feature code should never care which; if it does, that is a bug in the shim, not a reason to branch.

See the root `CLAUDE.md` for the full architecture, build commands, and account-aware rules.

## Focus

- Frontend code should call `src/lib/api.ts` (typed API surface), which routes through `src/lib/apiAdapter.ts` (`window.electronAPI.invoke`). Do not call `window.electronAPI.invoke()` directly from feature components — that is also what makes the remote shim a single seam rather than a per-component concern.
- Strip `undefined` from optional params before they cross the IPC boundary — the main process does not distinguish `undefined` from missing.

## Rules

- Reuse existing components and state patterns before creating new ones. UI stack is Radix UI + shadcn/ui + Tailwind v4 + Lucide; state is Zustand stores (`src/stores/`) plus React context (`src/contexts/` — `TabContext`, `ThemeContext`, `AccountsContext`).
- Keep account-aware UI consistent:
  - project open flow in `src/App.tsx`
  - account management in `src/components/AccountSettings.tsx`
  - active session state in `src/components/AgentSession.tsx`
  - account badges wherever project/run attribution matters (`AccountBadge.tsx`, `AccountPickerDialog.tsx`)

## High-Value Areas

- `src/App.tsx`
  Project picker, account picker handoff, high-level navigation, tab system integration
- `src/components/AgentSession.tsx`
  Streaming session UX (formerly `ClaudeCodeSession.tsx`) — subscribes to `session-*` / `claude-stream` / `agent-output:*` event channels exposed via the preload prefix allow-list
- `src/components/AccountSettings.tsx`
  Accounts + path rule management UI
- `src/components/Settings.tsx`
  Settings shell and account settings entry point
- `src/components/ProjectList.tsx`
  Project/account presentation
- `src/contexts/AccountsContext.tsx`
  Shared account list + color lookup
- `src/lib/api.ts`
  Typed API surface — the only thing feature components should import from
- `src/lib/apiAdapter.ts`
  IPC transport — thin wrapper over `window.electronAPI.invoke`
- `src/lib/remote/`
  The other end of that call in remote mode: `bootstrap.ts` (mode selection), `electronApiShim.ts` (channel → protocol method or `rpc.invoke`), `nativeChannels.ts` (what stays in Electron)

## Adding a New IPC Call

1. Add the service method + test in `electron/services/foo.ts` and `electron/__tests__/foo.test.ts` (TDD).
2. Wire the handler adapter in `electron/main.ts` and the interface entry in `electron/ipc/handlers.ts`.
3. Add the channel name to `INVOKE_CHANNELS` in `electron/ipc/channels.ts` — that is the list `electron/preload.ts` reads, and without an entry the preload layer rejects the invoke.
4. Decide whether the channel is **native-only**. If serving it needs a `BrowserWindow`, a display, a pty, or the updater, add it to `NATIVE_INVOKE_CHANNELS` in `src/lib/remote/nativeChannels.ts`.
5. Add the typed wrapper method in `src/lib/api.ts`.
6. Use it from the component.

Skipping step 3 is the most common "why is nothing happening?" bug — check `channels.ts` first when a new call silently fails.

Skipping step 4 is worse, because it does not fail: remote mode is the default, so the shim sends the channel to the daemon, the daemon's adapter bag has no such service, and the optional-chained handler returns `null`. The feature reads as "not configured" instead of broken.

## Verification

For renderer-only changes:
- `npm run check`
- `npm run build`

For anything that touches the IPC surface or a service, also run `npm test` (and `npm run test:coverage` if the change is non-trivial).
