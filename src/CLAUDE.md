# CLAUDE.md — src (renderer)

React 18 + TypeScript + Tailwind v4 renderer for OmniFex, built with Vite. The renderer has no Node.js access; it talks to Electron's main process only through the IPC layer.

See the root `CLAUDE.md` for the full architecture, build commands, and account-aware rules.

## Focus

- Frontend code should call `src/lib/api.ts` (typed API surface), which routes through `src/lib/apiAdapter.ts` (`window.electronAPI.invoke`). Do not call `window.electronAPI.invoke()` directly from feature components.
- Strip `undefined` from optional params before they cross the IPC boundary — the main process does not distinguish `undefined` from missing.

## Rules

- Reuse existing components and state patterns before creating new ones. UI stack is Radix UI + shadcn/ui + Tailwind v4 + Lucide; state is Zustand stores (`src/stores/`) plus React context (`src/contexts/` — `TabContext`, `ThemeContext`, `AccountsContext`).
- Keep account-aware UI consistent:
  - project open flow in `src/App.tsx`
  - account management in `src/components/AccountSettings.tsx`
  - active session state in `src/components/ClaudeCodeSession.tsx`
  - account badges wherever project/run attribution matters (`AccountBadge.tsx`, `AccountPickerDialog.tsx`)

## High-Value Areas

- `src/App.tsx`
  Project picker, account picker handoff, high-level navigation, tab system integration
- `src/components/ClaudeCodeSession.tsx`
  Streaming session UX — subscribes to `session-*` / `claude-stream` / `agent-output:*` event channels exposed via the preload prefix allow-list
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

## Adding a New IPC Call

1. Add the service method + test in `electron/services/foo.ts` and `electron/__tests__/foo.test.ts` (TDD).
2. Wire the handler adapter in `electron/main.ts` and the interface entry in `electron/ipc/handlers.ts`.
3. Add the channel name to the allow-list in `electron/preload.ts` (otherwise the preload layer rejects the invoke).
4. Add the typed wrapper method in `src/lib/api.ts`.
5. Use it from the component.

Skipping step 3 is the most common "why is nothing happening?" bug — check preload first when a new call silently fails.

## Verification

For renderer-only changes:
- `npm run check`
- `npm run build`

For anything that touches the IPC surface or a service, also run `npm test` (and `npm run test:coverage` if the change is non-trivial).
