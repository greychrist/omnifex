# The daemon dies with the app

Date: 2026-11-18. Status: approved (Greg, 2026-11-18).

## Why

The installed daemon is spawned detached and outlives the app on purpose
(`electron/remote/launcher.ts`). Two costs showed up in real use:

- **Permissions don't apply.** macOS credits the daemon and every `claude` it
  spawns to OmniFex.app, and applies a new Screen Recording (etc.) grant only
  to processes started after it. "Quit & Reopen" restarts the window, not the
  daemon, so sessions keep the old denial until the daemon is killed by hand.
  Seen 2026-11-18: daemon started 02:16:28, grant at 02:18:33, app relaunched
  02:18:38, daemon untouched.
- **Leftover processes.** A daemon running with no app is invisible except in
  Activity Monitor, and is easy to mistake for duplicates (the Brain MCP
  servers also show as `omnifexd`).

Greg's call: the daemon's lifetime is the app's. Quit the app, everything stops.

## Goals

- Quitting OmniFex (menu, ⌘Q, closing the last window, Quit & Reopen) stops the
  daemon and every CLI session under it.
- A daemon whose app vanished without a clean quit (crash, force-quit) exits on
  its own.
- A permission granted to OmniFex works after Quit & Reopen, with nothing else
  to do.

## Non-goals

- Removing the daemon or moving its Node services into Swift.
- Changing the dev instance's separate port/state dir or its closed
  periodic-work gate (the database is still shared).
- Renaming the Brain MCP processes (separate fix if wanted).

## Accepted losses

- Sessions stop on quit; a turn in progress is killed. The existing "Quit
  anyway?" prompt (`QuitPolicy`) still guards it. Tabs reload from the CLI's
  JSONL on relaunch, as after any daemon restart.
- The iPad reaches the daemon only while the Mac app is open.
- No LaunchAgent: no daemon at login without the app.

## Approaches

- **A (chosen): run the real daemon the way dev already runs.** Every piece
  exists and is tested on the dev side: non-detached spawn into the app's
  process group, stop on quit, idle watch as the backstop.
- B: the app spawns the daemon as a plain child and it exits when the pipe
  closes. Tighter (no 30s window after a hard kill) but rewrites the start-up
  path `ensure` owns, including replace-outdated. Rejected: more change,
  discards tested code.
- C: a "keep sessions running when OmniFex quits" setting. Rejected: keeps both
  lifetimes and all their code; Greg asked for one.

## Design

1. **Spawn** — `ensure` spawns the daemon non-detached for every instance
   (`detached: !dev` → always false), and the Mac app runs `ensure`/`stop`/
   `restart` in its own process group for every instance
   (`LauncherProcessGroup.forDaemonCLI` → always `.callers`).
2. **Quit** — `AppServices.willTerminate` stops the daemon for every instance
   (`stopSync` currently hard-codes `--dev`; it passes `--dev` only for dev).
3. **Backstop** — the idle watch runs in every daemon, not just dev: exit once
   no client is attached and no turn is in flight for 30s, or when no client
   has connected within 2 minutes of start. Renamed from `createDevIdleWatch`
   to `createIdleWatch` (and its constants), since it is no longer dev's.
4. **Start** — unchanged. `ensure` at launch starts a daemon, adopts a same-
   version one (only a crash leftover inside its 30s window), or replaces an
   older one.
5. **launchd removed** — `launchd.ts`, `install`/`uninstall`, the launchd paths
   in `daemon-control.ts`, `launchdAllowed`, and their tests. A KeepAlive job
   would respawn the daemon the app just stopped. No migration: no machine has
   the plist installed (checked `~/Library/LaunchAgents` and `launchctl list`
   on Greg's Mac; nothing installs it but a manual `omnifex-server install`).
6. **Dead code** — with `detached` and the process-group choice always one
   value, the options themselves go (`detached` in daemon-control,
   `LauncherProcessGroup`'s `.own` path for the daemon CLI, the dev/real
   branches in comments and tests).
7. **Docs** — CLAUDE.md (Shape of the App: Daemon, the dev-instance and
   LaunchAgent rules), `docs/remote-access.md`, `launcher.ts` and
   `dev-instance.ts` headers.

## Tests (written first)

- daemon-control: the real instance spawns non-detached.
- idle watch: applies with no dev marker in the environment.
- server `start`: arms the idle watch for a real daemon.
- Swift: `forDaemonCLI` is `.callers` for a packaged app; the quit path issues
  `stop` without `--dev` for a packaged app.
- Swift: a dev app's quit always passes `--dev` and a packaged app's never
  does — the dev build can never stop the installed daemon (separate state
  dir, pid file and port; Greg asked, 2026-11-18).
- launchd tests deleted with the code.

## Left to the builder

- Whether `Spawn.output`'s `group:` parameter keeps a default of `.own` for
  its other callers.
- Exact wording of the doc updates.

## Risks

- A force-quit mid-turn leaves the daemon running until that turn ends, plus
  30s. Acceptable; it then exits.
- `stopSync` has a 2s budget; a daemon whose close (Brain drain) takes longer
  keeps closing after the app is gone, then exits. Same as dev today.
