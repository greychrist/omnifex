# CLAUDE.md — src (renderer)

React 19 + TypeScript + Tailwind v4 renderer for OmniFex, built with Vite. The renderer has no Node.js access.

The same bundle, served by the daemon, runs in two places: the Mac app's WKWebView and a browser. `src/lib/remote/bootstrap.ts` installs `window.electronAPI` (the name is the Electron era's) — a WebSocket shim onto the daemon that, on the Mac, sends the native-only channels to the app's bridge (`window.__omnifexNative`). Feature code should never care which host it is in; if it does, that is a bug in the shim, not a reason to branch.

See the root `CLAUDE.md` for the full architecture, build commands, and account-aware rules.

## Focus

- Frontend code should call `src/lib/api.ts` (typed API surface), which routes through `src/lib/apiAdapter.ts` (`window.electronAPI.invoke`). Do not call `window.electronAPI.invoke()` directly from feature components — that is also what makes the remote shim a single seam rather than a per-component concern.
- Strip `undefined` from optional params before they cross the IPC boundary — the daemon does not distinguish `undefined` from missing.

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
  Streaming session UX (formerly `ClaudeCodeSession.tsx`) — subscribes to `session-*` / `claude-stream` / `agent-output:*` event channels the shim re-emits from daemon pushes
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
  The other end of that call: `bootstrap.ts` (installs the shim), `electronApiShim.ts` (channel → protocol method, `rpc.invoke` or the native bridge), `nativeChannels.ts` (what the Mac app serves)

## Adding a New IPC Call

1. Add the service method + test in `electron/services/foo.ts` and `electron/__tests__/foo.test.ts` (TDD).
2. Wire it in `electron/remote/daemon.ts` and add the handler + interface entry in `electron/ipc/handlers.ts`.
3. Add the channel name to `INVOKE_CHANNELS` in `electron/ipc/channels.ts`. The rpc allowlist starts from that list, so the channel is now reachable from every client — deny it in `electron/remote/rpc-allowlist.ts` if it should not be.
4. Decide whether the channel is **native-only**: it needs the machine the window is on (a dialog, Finder, the dock, notifications, the app bundle). If so it does not go in the daemon at all — add it to `NATIVE_INVOKE_CHANNELS` in `src/lib/remote/nativeChannels.ts`, to `macos/Sources/OmniFexCore/NativeChannels.swift`, and give it a handler in `macos/Sources/OmniFex/NativeHandlers.swift`. `ipc-channel-contract.test.ts` fails until all three agree.
5. Add the typed wrapper method in `src/lib/api.ts`.
6. Use it from the component.

## Verification

For renderer-only changes:
- `npm run check`
- `npm run build`

For anything that touches the IPC surface or a service, also run `npm test` (and `npm run test:coverage` if the change is non-trivial).
