# OmniFex — macOS app

The native shell around the renderer the OmniFex daemon serves. Design:
`docs/superpowers/specs/2026-10-23-swift-shell-design.md`.

## Targets

- **OmniFexCore** — every rule worth a test, no AppKit: navigation policy,
  the `greychrist-file` image policy, open-path planning, quit/reload
  wording, the tab-status aggregator, notification sounds, updater and
  installer logic, PDF sizing, the daemon CLI's answer, the native channel
  list (`NativeChannels.swift`, mirrored from
  `src/lib/remote/nativeChannels.ts`), dialog options, settings reads.
- **OmniFex** — the AppKit executable: menus, windows, `WKWebView`, the
  `window.__omnifexNative` bridge, and one handler per native channel
  (`NativeHandlers.swift`).

## Build and test

```bash
cd macos
swift test                 # OmniFexCore
swift build -c release     # binary: $(swift build -c release --show-bin-path)/OmniFex
```

The binary is only useful inside an app bundle (notifications need a bundle
identifier); `scripts/` at the repo root assembles one.

## Environment overrides

| Variable | Default (packaged) | Use |
|---|---|---|
| `OMNIFEX_NODE` | `Contents/MacOS/omnifexd` | Node that runs the daemon CLI |
| `OMNIFEX_DAEMON_SCRIPT` | `Contents/Resources/app/build/omnifex-server.js` | the daemon bundle |
| `OMNIFEX_DEV_SERVER_URL` | unset | dev: load the Vite server, pass `--dev` to the CLI |
| `OMNIFEX_USER_DATA_DIR` | `~/Library/Application Support/OmniFex` | where `greychrist.db` is (notification sound settings) |

`OMNIFEX_STATE_DIR`, `OMNIFEX_PORT` and the rest pass straight through to the
daemon CLI, which is how a throwaway smoke run stays off the real daemon.
