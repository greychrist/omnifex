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
- [ ] 3.1 `src/lib/remote/serverClient.ts`: `ProtocolClient` over WebSocket, reconnect w/ backoff, resubscribe from `lastSeenSeq`. Tests (mock ws).
- [ ] 3.2 `src/lib/remote/electronApiShim.ts`: `window.electronAPI`-shaped object over the client; tabId⇄sessionId map; legacy channel routing; `session_*` param rewrite. Tests.
- [ ] 3.3 `src/lib/platform.ts`: dialogs/shell/reveal/window/save_pasted_image/updater behind `platform` with Electron + web impls.
- [ ] 3.4 Renderer bootstrap: install shim when running in Electron (daemon on localhost) and on web (`location.host`).
- [ ] 3.5 Electron main: spawn/attach daemon on localhost; keep platform IPC; stop registering session handlers once shim verified. Delete old handlers last, separate commit.
- [ ] Verification: `npm run check`, `npm test`, `npm run build`, `npm run package` launches.
- [ ] Commit "Phase 3".

## Phase 4 — Web client build
- [ ] 4.1 Vite web build config → `dist-web/` with web platform, server URL from `location`.
- [ ] 4.2 `manifest.webmanifest` + minimal service worker; daemon serves at `/` from `webRoot`.
- [ ] 4.3 Docs: `tailscale serve` fronting for HTTPS (`docs/remote-access.md`).
- [ ] Commit "Phase 4".

## Phase 5 — iPad-first UI
- [ ] 5.1 Narrow layout: session list root, pushed session view w/ back; wide keeps split.
- [ ] 5.2 Permission sheet with large Approve / Deny / Approve-and-remember.
- [ ] 5.3 Composer anchored bottom; visualViewport resize.
- [ ] 5.4 Swipe between sessions; pull-to-refresh list.
- [ ] 5.5 Code/diff blocks: horizontal scroll, copy button.
- [ ] 5.6 Reconnect: resubscribe from lastSeenSeq; "caught up N events" affordance.
- [ ] 5.7 Keyboard: Cmd+Enter send, Cmd+[ / ] switch sessions.
- [ ] Commit "Phase 5".

## Phase 6 — Web Push (optional, last)
- [ ] VAPID keys + `~/.omnifex/push.json`; push on `permission.request` and running→idle; tap deep-links.
- [ ] Commit "Phase 6".

## Follow-ups (not in scope tonight)
- Deduplicate service construction between `electron/main.ts` and `electron/remote/daemon.ts`.
- Purge `raw` from `event.payload`.
- TUI on web with takeover semantics.
