# Swift shell — replacing Electron

Date: 2026-10-23. Status: approved by Greg in conversation ("go pure Swift",
"build it until it's finished"); he waived reviewing this document.

## Why

The Node.js security release of 2026-10-21 (10 CVEs, a Brotli RCE among them)
left the shipped app exposed: Electron 41 bundles Node 24.18.0, and Electron
41 stopped receiving releases in August. Electron's cadence decides when
OmniFex can ship a Node fix. Since the OmniFex Remote split, Electron is only
a window around a renderer that already talks to a Node daemon over a
WebSocket — so the window is replaced by a native Swift app, and the daemon
runs on a Node binary OmniFex bundles itself.

## Decisions (Greg's)

- Swift (AppKit + WKWebView), macOS only. No Rust/Tauri, no Windows.
- The daemon stays Node. Bundled Node is **26.x** (26.12.1, patched).
- Minimum macOS **27**.
- Bundle ID stays `com.omnifex.app` — one other person runs OmniFex, and
  their install must update in place.
- Every native feature keeps working.

## Calls made (mine)

- **One mode.** The app always talks to the daemon. The legacy in-process
  mode (`OMNIFEX_REMOTE=0`, `remote.enabled=false`, "use local mode") and
  main.ts's duplicate service graph are deleted. Daemon down ⇒ the window
  shows an error with Retry, not a fallback.
- **The page is served by the daemon.** The window loads
  `http://<daemon host>:<port>/` (the same `dist-web` the iPad gets). Same
  origin as the WebSocket, no mixed-content questions, and the renderer the
  window shows always matches the daemon serving it. Dev loads the Vite dev
  server instead.
- **Updater: the existing GitHub-release flow, ported to Swift.** Same zip
  asset name (`OmniFex-darwin-arm64-<v>.zip`), same renderer UI, same
  idle-gate. No Sparkle: no new signing key, no appcast, and — the deciding
  point — the Electron app's own updater installs the Swift app from that
  same zip, because it only checks `Contents/MacOS/OmniFex` and
  `CFBundleShortVersionString`.
- **Daemon lifecycle logic stays in TypeScript.** `remote-launcher.ts`
  (replace an outdated daemon, wait while busy) and `daemon-control.ts`
  (launchd-aware stop/spawn) are tested and subtle. The Swift app runs them
  through the daemon CLI: `omnifexd omnifex-server.js ensure|restart|stop`.
- **Anything that can run headless moves into the daemon**, so the iPad gets
  it too: the one-shot pty (Claude/Codex sign-in), Codex/Claude identity
  watchers, `save_pasted_image`, first-run account discovery, CLI
  auto-update at startup.
- **Swift keeps only what needs a display**: windows, menus, dialogs, Finder,
  notifications and the dock badge, sounds, PDF export, power/lock events,
  the tab-status aggregator (it is per-window state), quit/reload prompts,
  the updater.
- **Process names.** The bundled Node binary is `Contents/MacOS/omnifexd`, so
  the daemon is named without a stub copy. The Brain MCP server (spawned by
  the CLI) runs on the same binary and is named `omnifexd` too.
- **LaunchAgent only for the default state dir.** A throwaway
  `OMNIFEX_STATE_DIR` or the dev instance never touches
  `com.omnifex.server`.
- **Renderer localStorage does not migrate** from Electron (LevelDB under
  userData); the new origin starts empty. Tabs persisted there are lost once.

## Bundle layout

```
OmniFex.app/Contents/
  Info.plist                    CFBundleExecutable=OmniFex, id com.omnifex.app,
                                LSMinimumSystemVersion 27.0
  MacOS/OmniFex                 the Swift app
  MacOS/omnifexd                Node 26.12.1 (official darwin-arm64 binary)
  Resources/icon.icns
  Resources/greychrist_success.aiff
  Resources/app/
    package.json                { name, version }
    build/omnifex-server.js     daemon (CJS bundle)
    build/brain-mcp.js          Brain MCP server
    node_modules/               externals: better-sqlite3 (+bindings,
                                file-uri-to-path), node-pty, ws, web-push trees
    dist-web/                   the renderer
    omnifex-mod/                bundled Claude Code mod
```

`build/` sits two levels under `app/`, so the existing `../../dist-web` and
`../../omnifex-mod` candidates resolve unchanged.

## Native bridge contract

Injected by the Swift app as a `WKUserScript` at document start, main frame
only:

```js
window.__omnifexNative = {
  invoke(channel, params) -> Promise<unknown>,   // WKScriptMessageHandlerWithReply "omnifex"
  onEvent(channel, cb) -> () => void,
};
window.__omnifexNativeEmit(channel, args[])      // Swift → page
```

Channels (`src/lib/remote/nativeChannels.ts` is the source of truth; a vitest
guard checks the Swift router names every one):

| Channel | Params | Returns |
|---|---|---|
| `dialog:open` | Electron-shaped `{properties[], title, defaultPath, buttonLabel, filters[]}` | `string[] \| null` |
| `dialog:save` | `{title, defaultPath, buttonLabel, nameFieldLabel, filters[], properties[]}` | `string \| null` |
| `shell:openExternal` | url **string** (http/https only) | `null` |
| `reveal_path_in_finder` | `{path}` | `null` |
| `open_path` | `{path, cwd?}` — runnable files are revealed, never opened | `null` |
| `window:minimize` / `window:maximize` / `window:close` | — | `null` |
| `get_app_version` | — | `CFBundleShortVersionString` |
| `updater:check` | — | `{available, version, downloadUrl, assetName, releaseUrl, releaseNotes} \| null` |
| `updater:download` | `{url, assetName}` | downloaded path; emits `updater:progress` |
| `updater:open` | `{filePath}` | opens it, quits after 1.5 s |
| `updater:install` | `{zipPath, version, force?}` | stage → verify → wait for idle → swap; emits `updater:install-status` |
| `updater:install-cancel` | — | `{success:true}` |
| `cost_report_export_pdf` | `{filters, hash, savePath}` | `{path}` |
| `cost_report_print_ready` | `{widthPx, heightPx, chartExpected, chartRendered}` (from the print view) | `null` |
| `preview_notification_sound` | `{id}` | `{played, path}` |
| `tab_status_publish` / `tab_status_remove` / `tab_status_list` | as before | as before |
| `remote:url` | — | daemon `ws://…/ws` or `null` |
| `remote:restart` | — | `{url}` |
| `notify:show` | `{title, body, isError, tabId}` | `null` |

Events the Swift app emits: `updater:progress`, `updater:install-status`,
`notification-clicked {tabId}`, `tab-status:changed [summaries]`,
`system-power-state {awake}`, `session-inflight-count {count}`.

Errors reject the promise with the handler's message; unknown channels reject
with `Blocked IPC channel: <name>`.

## Daemon CLI contract

`<omnifexd> <app>/build/omnifex-server.js <cmd> [flags]`, environment
inherited:

- `ensure --app-version <v> [--app-build <stamp>] [--dev]` → last stdout line
  is JSON `{"url": "ws://…/ws" | null, "outdated": boolean}`. `outdated`
  means an older daemon is busy and was attached to; the app re-runs `ensure`
  30 s later.
- `restart [--dev]` → same JSON.
- `stop [--dev]` → existing behaviour.
- `--dev` applies the dev-instance overlay (`~/.omnifex-dev`, port 47701,
  `OMNIFEX_DEV_DAEMON=1`) and keeps the daemon in the caller's process group.
  The app therefore runs the CLI with `posix_spawn` into its own group
  (`LauncherProcessGroup`), not `Process`, which would make it a new group's
  leader and strand the dev daemon outside Ctrl-C's reach.

- `stop [--dev]` uses `daemon-control`'s stop: `launchctl bootout` when the
  LaunchAgent owns the daemon (KeepAlive would otherwise resurrect it), then
  SIGTERM via the pid file. The installer calls it before swapping the bundle.

## Swift app: where things come from

| What | Packaged | Override (dev / smoke runs) |
|---|---|---|
| Node | `Contents/MacOS/omnifexd` | `OMNIFEX_NODE` |
| Daemon script | `Contents/Resources/app/build/omnifex-server.js` | `OMNIFEX_DAEMON_SCRIPT` |
| Page | `http://<host>:<port>/` from the `ensure` URL | `OMNIFEX_DEV_SERVER_URL` (dev mode iff set; passes `--dev`, and `--app-build <script mtime>`) |
| Settings (notification sounds) | `greychrist.db` → `app_settings` (`notification_sound_success`, `notification_sound_error`), read with SQLite3 | `OMNIFEX_USER_DATA_DIR` (default `~/Library/Application Support/OmniFex`) |
| Daemon health (install gate) | `GET http://<host>:<port>/healthz` → `sessions.inFlight` | — |

Window flow: a window opens with a native "Starting OmniFex…" view, runs
`ensure`, then loads the page; on failure the view shows the error, the log
path (`~/Library/Logs/omnifex-server.log`) and Retry. Every window, and the
hidden PDF print view, gets the bridge. Tab-status sources are per web view
and retired when that view navigates, reloads or closes.

Quit (⌘Q or closing the last window) asks only when tabs report
`promptStatus === 'working'`; the wording says the sessions keep running in
the daemon and that queued prompts are lost. Reload Window keeps its
confirmation and has no shortcut. ⌘W stays the renderer's (close tab);
Close Window is ⇧⌘W.

## Dev workflow

`npm start` builds the daemon bundles, starts the Vite dev server, builds the
Swift app (debug) into `out/dev/OmniFex Dev.app` (bundle id
`com.omnifex.app.dev`) and launches it with `OMNIFEX_DEV_SERVER_URL`,
`OMNIFEX_NODE` (system Node 26) and `OMNIFEX_DAEMON_SCRIPT`
(`<repo>/.vite/build/omnifex-server.js`). Quitting the dev app runs
`stop --dev`.

## What gets deleted

Electron, Electron Forge and every `@electron-forge/*` package, `electron/main.ts`,
`preload.ts`, `registerIpcHandlers`, `window-router`, `context-menu-template`,
`navigation-policy`, `file-protocol-policy`, `quit-policy`, `reload-policy`,
`power-state`, `remote-launcher`'s Electron caller, `daemon-exec`,
`packaging/daemon-stub.ts`, the notification/sound/PDF/tab-status/updater/
installer/userdata-migration services (ported to Swift with their tests), the
legacy-mode renderer paths, `rebuild:electron` and the pretest ABI dance.
