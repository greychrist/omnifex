# OmniFex Remote — running sessions from the iPad

OmniFex Remote splits the app in two: a **daemon** on the Mac that owns every
Claude CLI session, and **clients** that talk to it over a WebSocket protocol.
The Mac app (`macos/`) is one client. The same renderer, served by the daemon, is a
Safari Home Screen app on the iPad.

The boundary is your tailnet. There is no login: the daemon binds to the
Tailscale interface (never `0.0.0.0` by default) and anyone who can reach that
address is you.

## Parts

| Piece | Where | Notes |
|---|---|---|
| Daemon | `omnifex-server` (built to `.vite/build/omnifex-server.js`) | Runs on the app's bundled Node 26 (`Contents/MacOS/omnifexd`), or a checkout's node — one native ABI. |
| Config | `~/.omnifex/server.json` | `host`, `port` (47700), `webRoot`, `ringSize`, `permissionTimeoutMs` (null = never), `rpcAllow`, `rpcDeny`. |
| State | `~/.omnifex/sessions/`, `~/.omnifex/projects.json`, `~/.omnifex/server.pid` | Per-session event log + meta; project registry. |
| Database | `~/Library/Application Support/OmniFex/greychrist.db` | Shared with the dev daemon when one runs (WAL + busy timeout). |
| Web client | `dist-web/` (`npm run build:web`) | Served at `/` to the Mac app's window and to browsers alike. Packaged in `Contents/Resources/dist-web`. |
| Logs | `~/Library/Logs/omnifex-server.log` | The daemon's stdout/stderr. |

## Lifetime: the daemon is the app's

The Mac app starts the daemon at launch — `omnifexd omnifex-server.js ensure`
— inside its own process group, and stops it when it quits (`stop`, waiting up
to 6 s for it to exit). Quitting OmniFex, closing its last window, or "Quit &
Reopen" therefore ends every session; the "Quit anyway?" prompt asks first
when a turn is running, and tabs reload from the CLI's transcript on the next
launch. If the app dies without quitting (crash, force-quit), the daemon's idle
watch stops it 30 s after the last client disconnects — once any running turn
has finished — or 2 min after start if no client ever connected.

It used to be detached, or a `com.omnifex.server` LaunchAgent with KeepAlive,
so it outlived the app. That kept sessions running across quits but also kept
the permissions macOS had granted before the daemon started: a new Screen
Recording grant to OmniFex never reached the sessions until the daemon was
killed by hand. See `docs/superpowers/specs/2026-11-18-daemon-dies-with-app-design.md`.

The consequence for the iPad: it reaches the daemon only while the Mac app is
open.

The daemon re-derives `PATH` from your login shell on every start (`fixPath`)
and refuses to start if `claude` cannot be found.

Commands: `start` (foreground), `stop`, `status --json`, `ensure`, `restart`,
`config`.

## Upgrades

On launch the app compares the answering daemon's version (`/healthz`) with
its own and, when they differ, replaces it: immediately if no turn is in
flight, otherwise it uses the old one for now and checks back every 30 seconds
until it is idle. Normally the daemon died with the previous app, so this
only meets a crash leftover or a daemon from a release that still spawned it
detached.

The in-app updater is daemon-aware: its "wait for idle" gate also counts
turns running in the daemon (a session open only on the iPad, say), and it
stops the daemon just before quitting for the swap so nothing keeps running
from the bundle being replaced. The relaunched app starts a fresh daemon from
the new bundle.

## Dev builds get their own daemon

`npm start` runs as the **dev instance**: state in `~/.omnifex-dev`, daemon on
port **47701**, and `OMNIFEX_DEV_DAEMON=1` in the environment it spawns the
daemon with. The installed app keeps `~/.omnifex` and 47700.

This exists because the two used to share one daemon on one port. That daemon
holds every live CLI process the user has open, so launching a dev build both
replaced it (same version, different bundle stamp → "another build; replacing
it") and, once that was fixed, still drove those real sessions from a build
under test. A dev build now also refuses to retire a daemon that does not
report its own script path in `/healthz`, and its quit runs `stop --dev`,
which can only reach `~/.omnifex-dev`'s pid file.

What is deliberately NOT separate is the database: the dev app sees the real
accounts, projects and history. That is why the dev daemon passes an `enabled`
gate that closes `startPeriodicWork` — with two daemons on one
`greychrist.db`, a second Brain sweep would re-queue what the other is
extracting, and `brain_spend` is append-only, so it gets billed twice.
Maintenance belongs to the installed pair; it simply waits until that app runs.

```sh
OMNIFEX_DEV_INSTANCE=0 npm start   # share the real daemon on purpose
curl http://<tailscale-ip>:47701/healthz
```

The dev daemon is also **temporary**, which the real one deliberately is not.
It is spawned in the app's process group (so Ctrl-C in the `npm start`
terminal reaches it), SIGTERMed on quit, and it runs a dead-man's switch: no
client attached, no turn running, 30 seconds → it shuts itself down. That last
one is the backstop for the app being killed outright, and it also collects a
daemon whose app never connected at all (2 minutes). So every `npm start` gets
a fresh daemon built from the current tree — no Restart needed for daemon-side
changes, and nothing left listening on 47701 afterwards.

The one thing it will not do is kill a turn: a disconnected client with a
running CLI is an app being reloaded, so the clock starts when the turn ends.

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

- File dialogs, Reveal in Finder, the updater, window chrome, OS
  notifications through the dock — the Mac app's native channels
  (`src/lib/remote/nativeChannels.ts`), behind `src/lib/platform.ts`.
- Anything on the daemon's `rpcDeny` list (raw SQL and row editing by default).
