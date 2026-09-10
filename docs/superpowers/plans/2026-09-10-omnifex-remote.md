# OmniFex Remote: Headless Daemon + Thin Clients — Implementation Plan

> **For agentic workers:** this run is unattended (Greg reviews in the morning). If context was compacted, first apply the post-compact directive (`DEFAULT_POST_COMPACT_PROMPT` in `src/lib/postCompactPrompt.ts`): re-read sources before stating specifics; then resume from the first unchecked box below. Commit at the end of each phase with a message naming the phase. Branch: `feat/omnifex-remote`.

**Goal:** Split OmniFex into (a) a headless daemon that owns all CLI-driven sessions and (b) clients over a WebSocket protocol. The Electron renderer becomes one client; the same bundle served by the daemon becomes a Safari Home Screen web app on the iPad (Tailscale only, single user, no auth beyond the tailnet).

**Hard rule:** the Electron app must keep working at every phase. Move files intact; adapt edges.

**Decisions taken (Greg, 2026-09-10):**
1. `event.payload` for transcript events = the renderer's `JsonlNode` **including `raw`**. Purging `raw` is a later hardening pass.
2. Non-session IPC channels (~165) reach the daemon via a generic `rpc.invoke {channel, params}` with a **server-side allowlist**.
3. Daemon runs as `process.execPath` (Electron) with `ELECTRON_RUN_AS_NODE=1` — one native ABI (better-sqlite3, node-pty), same trick as `brain-mcp.ts`.
4. Web client is **chat (stream-json) only**; TUI stays Electron-only (pty resize conflict between two viewers).
5. Project registry entries carry `accountId` / `configDir` — the daemon cannot spawn without `CLAUDE_CONFIG_DIR`.

**Deviations from the plan text (recorded, deliberate):**
- No Agent SDK exists; sessions spawn the `claude` binary. "Pin the SDK" → the CLI changelog watermark is the drift signal.
- `session.state` carries the connection axis only (`starting|started|error|stopped`). `conversationStatus` is client-derived per `docs/session-lifecycle.md`; `awaiting_permission` is not a state. List-view rollup (`inFlight`, `pendingPermissions`) lives on `SessionSummary`, advisory.
- Code lives in `src/protocol/` and `electron/remote/`, not `packages/*` — single-package repo, `electron/` already imports from `src/lib/`, `brain-mcp.ts` is the precedent for a plain-node entry under `electron/`.
- Seq'd event log persists under `~/.omnifex/sessions/` (daemon-owned). The CLI's own JSONL has no seq and is not the replay source.
- `~/.claude/` does not exist on this machine; per-account `CLAUDE_CONFIG_DIR` is passed per session exactly as `lifecycle.start()` does today.

## Architecture

```
renderer (Electron or Safari)
   └─ window.electronAPI shim ── ServerClient (ProtocolClient over ws) ──► daemon
        legacy channel names ⇄ protocol messages; tabId ⇄ sessionId map
daemon (electron/remote/daemon.ts, plain node under ELECTRON_RUN_AS_NODE)
   ├─ services subset (same factories main.ts uses; same greychrist.db)
   ├─ SessionBridge: sendToRenderer(channel, payload) ⇒ SessionScopedPush + seq
   ├─ SessionLog: ring buffer (5000) + ~/.omnifex/sessions/<id>.events.jsonl + meta
   ├─ ProjectRegistry: ~/.omnifex/projects.json (+ accountId/configDir)
   ├─ ProtocolServer over ws + HTTP (/healthz, /api/sessions, /api/projects, static webRoot)
   └─ handlers: typed session methods → sessionsService (tabId := sessionId); rpc.invoke → getHandlerMap() with allowlist
```

Key trick: in the daemon **tabId === sessionId**. `lifecycle.start({ tabId: id, resumeSessionId: id })` pins the UUID; `hasTranscript()` decides `--resume` vs `--session-id`. Every `sendToRenderer('<prefix>:<tabId>')` therefore already carries the sessionId.

Channel → push mapping (bridge):
| legacy channel | push |
|---|---|
| `agent-output:<id>` with `type:'permission_request'` | `permission.request` |
| `agent-output:<id>` (else) | `event kind:'transcript' origin:'engine'` payload = `classifyJsonlLine(raw) ?? {kind:'unknown', raw}` |
| `claude-output-extra:<id>` | `event kind:'transcript' origin:'tail'` |
| `session-status:<id>` / `session-mode:<id>` / `session-tui-exit:<id>` | `session.state` |
| `session-init:<id>` | `event kind:'init'` |
| `session-control-state:<id>` | `event kind:'control-state'` |
| `session-account-mismatch:<id>` | `event kind:'account-mismatch'` |
| `session-tui-data:<id>` | `event kind:'tui-data'` |
| `agent-error:<id>` | `event kind:'stderr'` |
| `agent-complete:<id>` | `event kind:'complete'` |
| `elicitation-request:<id>` | `event kind:'elicitation'` |
| `claude-notification` (payload.tab_id) | `event kind:'notification'` |
| anything else (global) | `channel { channel, payload }` broadcast |

## Phase 1 — Protocol ✅ (commit ff71d73)
- [x] `src/protocol/{version,messages,interfaces,index}.ts`, 20 round-trip tests, main-side import guard.

## Phase 2 — Daemon
- [x] 2.1 `database.ts`: `busy_timeout` + WAL (two processes share greychrist.db during transition). Test.
- [x] 2.2 `sessions/permissions.ts` + `lifecycle.ts`: `respondPermission` accepts optional `requestId` (id-addressed; returns boolean). Test.
- [x] 2.3 Protocol additive: `EventKind += init|complete|elicitation`, `event.origin?`, new `channel` push. Tests updated.
- [x] 2.4 `electron/remote/session-log.ts`: seq + ring buffer + persistence + `history.get` paging. Tests.
- [x] 2.5 `electron/remote/bridge.ts`: channel→push mapping. Fixture-replay test (captured stream-json lines).
- [x] 2.6 `electron/remote/projects.ts`: registry. Tests.
- [x] 2.7 `electron/remote/config.ts`: `~/.omnifex/server.json`, Tailscale IP detection (100.64/10), never 0.0.0.0 by default. Tests.
- [x] 2.8 `electron/remote/server.ts`: `ProtocolServer` over `ws` + HTTP routes + static webRoot. Tests on ephemeral port.
- [x] 2.9 `electron/remote/handlers.ts`: `ProtocolHandlers` impl; permission timeout default never; rpc allowlist. Tests with fake sessions service.
- [x] 2.10 `electron/remote/daemon.ts`: composition root (services subset mirroring main.ts). Verifies `claude` on PATH at startup, fails loudly.
- [x] 2.11 `electron/remote/cli.ts` + `launchd.ts`: `omnifex-server start|stop|status|install`, plist to `~/Library/LaunchAgents/com.omnifex.server.plist` (KeepAlive, RunAtLoad, logs to `~/Library/Logs/omnifex-server.log`, PATH baked in). Tests for plist generation.
- [x] 2.12 Forge build entry for `electron/remote/cli.ts`; `scripts/omnifex-server` wrapper.
- [x] 2.13 Acceptance (2026-09-10, throwaway state via `OMNIFEX_STATE_DIR`/`OMNIFEX_USER_DATA_DIR`, real personal account): `curl /healthz` + `/api/*` OK; `scripts/remote-smoke.mjs` drove create→subscribe→turn.send→result ("pong", seq 1–33); `omnifex-server stop`/`start`; `session.resume` respawned with `--resume`, replayed 1–35 from disk, then a Write tool → `permission.request` → `permission.respond` by id → result "done", `hello.txt` on disk (seq 74).
  - Found & fixed: `ws` must be external to the vite bundle (bundled, its `bufferutil` fallback throws `unmask is not a function` on the first frame).
  - Found & fixed: the CLI realpaths its cwd (`/tmp` → `/private/tmp`), so `hasTranscript()` missed the transcript and the resume spawned `--session-id` → "Session ID … already in use". Registry and spawn now canonicalise paths.
  - Noted, not a bug: `stream_event` partials classify as `unknown` daemon-side — `classifyJsonlLine` has no case for them; the renderer coalesces partials from `raw` (`inflightCoalescer.ts`), and the Phase 3 shim re-emits `payload.raw`, so fidelity holds.
- [x] Commit "Phase 2".

## Phase 3 — Electron becomes a client
- [x] 3.1 `src/lib/remote/serverClient.ts`: `ProtocolClient` over WebSocket, reconnect w/ backoff, resubscribe from `lastSeenSeq`. Tests (mock ws).
- [x] 3.2 `src/lib/remote/electronApiShim.ts`: `window.electronAPI`-shaped object over the client; tabId⇄sessionId map; legacy channel routing; `session_*` param rewrite. Tests.
- [x] 3.3 `src/lib/platform.ts`: dialogs/shell/reveal/window/save_pasted_image/updater behind `platform` with Electron + web impls.
- [x] 3.4 Renderer bootstrap: install shim when running in Electron (daemon on localhost) and on web (`location.host`).
- [x] 3.5 Electron main spawns/attaches the daemon (`electron/remote-launcher.ts`: probe `/healthz` → spawn DETACHED → poll ≤10s → url or null), serves `remote:url` + `notify:show`; preload publishes the bridge as `electronAPI` **and** `__omnifexNative`; `main.tsx` awaits `installRemoteBridge()` before booting React.
  - **Deferred, deliberately:** the legacy `registerIpcHandlers(...)` service bag in `main.ts` is NOT removed. It is the fallback when `remote:url` is null (`OMNIFEX_REMOTE=0`, `remote.enabled=false`, daemon unreachable). Removing it unattended, without a human having used the app through the daemon, was the wrong risk. **Flip for Greg:** once the app works via the daemon, drop the non-native entries from the `registerIpcHandlers` bag (keep dialog/shell/window/updater/tab-status/one-shot-terminal/codex-auth/notify), stop constructing the sessions service in main, and let the daemon own the DB. Until then both processes share `greychrist.db` (WAL + busy_timeout) and both run the cost/brain sweeps — duplicate work, not corruption.
  - Verified without a UI: `src/lib/remote/__tests__/shim.integration.test.ts` (gated on `OMNIFEX_DAEMON_URL`) drove the live daemon through the shim on the legacy channel names — `session_start` → `agent-output:<tabId>` frames → Write `permission_request` card → `session_respond_permission` → `result` "ok" → `session_stop` → `session-status stopped`. Found & fixed: `session.kill` must announce `stopped` + `agent-complete` itself (`lifecycle.stop()` removes the handle before the engine exits and `runtime.ts` then suppresses the exit event).
  - Not verified tonight: the Electron window itself booting through the shim (no interactive display). `npm run check` / `npm run build` / `npm test` pass; the bootstrap falls back to legacy IPC on any failure, so the laptop cannot be left broken by this.
- [x] Verification: `npm run check`, `npm test`, `npm run build` (package/launch left for Greg — see 3.5).
- [x] Commit "Phase 3".

## Phase 4 — Web client build
- [x] 4.1 `vite.web.config.ts` → `dist-web/` (`npm run build:web`; also run by `prepackage`/`premake`, shipped as a forge `extraResource`). Same bundle; `bootstrap.ts` picks web mode when no preload bridge exists and connects to `ws(s)://location.host/ws`.
- [x] 4.2 `web/public/{manifest.webmanifest,sw.js,icon-256.png,icon-512.png}`; PWA meta in `index.html` (relative hrefs, inert under Electron); SW registered in web mode only, caches nothing. Daemon resolves `webRoot` from config or `dist-web` beside the bundle / beside app.asar (`electron/remote/webroot.ts`). Verified: `/`, `/manifest.webmanifest`, `/sw.js`, SPA deep link 200; missing asset 404; hashed `/assets/index-*.js` 200.
- [x] 4.3 `docs/remote-access.md`: install as LaunchAgent, sanity curls, `tailscale serve` for HTTPS, throwaway runs, web-client limits.
- [x] Commit "Phase 4".

## Phase 5 — iPad-first UI
- [x] 5.1 `useLayoutMode()` (narrow < 900px / coarse pointer / web, mirrored as `<html>` classes). On narrow, the tab strip hides while a chat tab is active — the session is a pushed view and its existing "Back to Project page" button is the way out; wide layouts unchanged. Verified in headless Chromium at 820×1180: project list → Launch → session view with no tab strip → a full turn (`web.txt` written).
- [x] 5.2 `PermissionCard` on touch: stacked, full-width, `min-h-12` buttons, Deny last (not under a resting thumb). Class toggle only; not visually verified (headless has no coarse pointer).
- [x] 5.3 `useKeyboardInset()` writes `--omnifex-keyboard-inset` from `visualViewport`; the composer pads by it plus `env(safe-area-inset-bottom)`. Dead band of 40px so a collapsing URL bar does not twitch it.
- [x] 5.4 `useSwipeTabs` (dispatches the same `switch-to-next/previous-tab` events as the keyboard; ignores swipes that start in a sideways-scrolling element) on the session container; `usePullToRefresh` on the SessionList scroller with a spinner indicator. Touch only.
- [x] 5.5 CSS: `pre` scrolls horizontally with no wrap on narrow/touch; 44px minimum tap targets on touch. Markdown code blocks already carry a copy button (`MarkdownBlock.tsx`).
- [x] 5.6 `RemoteConnectionBanner` ("Reconnecting to OmniFex…") + `CaughtUpPill` per session. Verified live: daemon stopped under the page → banner + client state `reconnecting`; daemon restarted → client reconnected with backoff, banner gone. Found & fixed: after a reconnect the shim now reconciles session status from `session.list` (a daemon restart kills its CLI children without ever logging `stopped`).
- [x] 5.7 Cmd/Ctrl+Enter sends from the composer (including the expanded editor); Cmd+[ / Cmd+] switch tabs.
- [x] Commit "Phase 5".

## Phase 6 — Web Push (optional, last)
- [x] `electron/remote/push.ts`: VAPID pair generated once into `~/.omnifex/push.json` (0600), subscriptions stored there, dead endpoints (404/410) dropped on send; `pushPayloadFor()` fires for `permission.request` and for a `cli-stream-result` (turn finished / error) **only when no client is subscribed to that session**. `web-push` external in both builds; loaded lazily so a missing module costs push, not sessions. Routes: `GET /api/push/vapid-public-key`, `POST /api/push/subscribe|unsubscribe` (the only POSTs the daemon accepts). Verified live with curl: key generated, subscribe stored, unsubscribe removed, bad body 400.
- [x] Client: `src/lib/remote/push.ts` (`pushSupport`, `enablePush`, `disablePush`, `deepLinkedSessionId`); `PushEnableBar` under the title bar on the web client while permission is undecided and the origin is secure; the service worker's `push`/`notificationclick` handlers open `/#session=<id>`; `App.tsx` focuses or opens that session's tab on load and on `hashchange`.
- [ ] Not verified on a device: Safari only grants push to an installed Home Screen app on HTTPS — needs the `tailscale serve` origin from Phase 4 and a real iPad.
- [x] Commit "Phase 6".

## Follow-ups (not in scope tonight)
- Deduplicate service construction between `electron/main.ts` and `electron/remote/daemon.ts`.
- Purge `raw` from `event.payload`.
- TUI on web with takeover semantics.
