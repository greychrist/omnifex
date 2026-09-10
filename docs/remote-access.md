# OmniFex Remote — running sessions from the iPad

OmniFex Remote splits the app in two: a **daemon** on the Mac that owns every
Claude CLI session, and **clients** that talk to it over a WebSocket protocol.
The Electron app is one client. The same renderer, served by the daemon, is a
Safari Home Screen app on the iPad.

The boundary is your tailnet. There is no login: the daemon binds to the
Tailscale interface (never `0.0.0.0` by default) and anyone who can reach that
address is you.

## Parts

| Piece | Where | Notes |
|---|---|---|
| Daemon | `omnifex-server` (built to `.vite/build/omnifex-server.js`) | Runs as the Electron binary with `ELECTRON_RUN_AS_NODE=1` — one native ABI. |
| Config | `~/.omnifex/server.json` | `host`, `port` (47700), `webRoot`, `ringSize`, `permissionTimeoutMs` (null = never), `rpcAllow`, `rpcDeny`. |
| State | `~/.omnifex/sessions/`, `~/.omnifex/projects.json`, `~/.omnifex/server.pid` | Per-session event log + meta; project registry. |
| Database | `~/Library/Application Support/OmniFex/greychrist.db` | Shared with the Electron app (WAL + busy timeout). |
| Web client | `dist-web/` (`npm run build:web`) | Served at `/`. Also packaged as an extra resource. |
| Logs | `~/Library/Logs/omnifex-server.log` | launchd's stdout/stderr. |

## Install as a LaunchAgent

From a login shell (so `PATH` — where `claude` lives — is captured):

```sh
npm run build:daemon          # .vite/build/omnifex-server.js  (forge builds it too)
npm run build:web             # dist-web/
./scripts/omnifex-server install
./scripts/omnifex-server status
```

`install` writes `~/Library/LaunchAgents/com.omnifex.server.plist` with
`RunAtLoad`, `KeepAlive`, the captured `PATH`, and loads it. The daemon also
re-derives `PATH` from your login shell on every start (`fixPath`), and refuses
to start if `claude` cannot be found.

Other commands: `start` (foreground), `stop`, `status --json`, `uninstall`,
`config`.

The Electron app will also start the daemon itself if none is running
(detached, so it survives quitting the app). Set `OMNIFEX_REMOTE=0` or the
`remote.enabled=false` setting to make the app use its built-in IPC instead.

## Upgrades

Nothing to do. The daemon outlives the app, so after installing a new
OmniFex the old daemon is still the one answering on the port. On launch the
app compares the daemon's version (`/healthz`) with its own and, when they
differ, replaces it: immediately if no turn is in flight, otherwise it uses
the old one for now and checks back every 30 seconds until it is idle. When
the LaunchAgent is installed, the plist is rewritten to point at the new
bundle and reloaded, so `install` never has to be run again. Sessions that
were open show as stopped after the swap; sending the next message resumes
them.

The in-app updater is daemon-aware too: its "wait for idle" gate also
counts turns running in the daemon (a session open only on the iPad, say),
and it stops the daemon just before quitting for the swap so nothing keeps
running from the bundle being replaced. The relaunched app starts a fresh
daemon from the new bundle.

## Sanity checks from the iPad

```sh
curl http://<tailscale-ip>:47700/healthz
curl http://<tailscale-ip>:47700/api/sessions
curl http://<tailscale-ip>:47700/api/projects
```

## HTTPS with `tailscale serve`

Safari needs a secure origin for a real Home Screen app (service worker,
`standalone` display, notifications). Keep the daemon on plain HTTP on the
tailnet IP and let Tailscale terminate TLS:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:47700
tailscale serve status
```

Then open `https://<machine>.<tailnet>.ts.net/` in Safari on the iPad, Share →
**Add to Home Screen**. The client connects its WebSocket to `wss://` on the
same host automatically.

If the daemon is bound to the Tailscale IP rather than loopback (the default
when Tailscale is up), point `serve` at that IP instead, or set
`"host": "127.0.0.1"` in `server.json` so both the app and `tailscale serve`
talk to loopback.

## Driving it by hand

`scripts/remote-smoke.mjs` runs one full turn over the protocol — create,
subscribe, send, approve the first permission, wait for the result — and
`--resume <sessionId>` does the same against a persisted session:

```sh
node scripts/remote-smoke.mjs --url ws://127.0.0.1:47700/ws --project ~/Repos/x
```

## Throwaway runs

```sh
OMNIFEX_STATE_DIR=/tmp/omnifex-state OMNIFEX_USER_DATA_DIR=/tmp/omnifex-userdata \
  ./scripts/omnifex-server start
```

A fresh user-data dir has no accounts; the smoke script creates one for
`~/.claude-personal` when it finds none.

## Push notifications (web client)

Once the page is served over HTTPS (`tailscale serve` above), the web client
offers **Enable notifications** in a bar under the title bar. Accepting
subscribes the device with the daemon's VAPID key; the daemon then pushes
when — and only when nobody has that session open on screen — a session
needs a permission, or a turn finishes. Tapping opens the session.

State: `~/.omnifex/push.json` (VAPID key pair + subscriptions, mode 0600).
Routes: `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`,
`POST /api/push/unsubscribe`. Dead subscriptions (404/410 from the push
service) are dropped automatically. Deleting the file rotates the key and
invalidates every subscription — a decision, not a side effect.

## What the web client cannot do

- Terminal (TUI) sessions — chat mode only. One pty cannot have two viewers.
- File dialogs, Reveal in Finder, pasting an image to a temp file, the
  updater, window chrome — Electron-only, behind `src/lib/platform.ts`.
- Anything on the daemon's `rpcDeny` list (raw SQL and row editing by default).
