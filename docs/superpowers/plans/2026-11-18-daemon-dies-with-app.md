# The Daemon Dies With the App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The installed daemon's lifetime becomes the app's: quitting OmniFex stops it, and a daemon whose app vanished exits on its own.

**Architecture:** Run the real daemon the way the dev daemon already runs — spawned non-detached into the app's process group, stopped on quit, with the idle watch as the backstop — and delete the LaunchAgent and every option that only existed to choose between the two lifetimes.

**Tech Stack:** TypeScript daemon (Node 26, Vitest), Swift app (Swift 6, Swift Testing).

**Spec:** `docs/superpowers/specs/2026-11-18-daemon-dies-with-app-design.md`

## Global Constraints

- Branch `feat/daemon-dies-with-app` in the main checkout. No worktrees.
- TDD: each test is written and seen failing before its code.
- Dead code goes in the same task that makes it dead (CLAUDE.md "Working Style").
- The dev instance keeps its own state dir (`~/.omnifex-dev`), port (47701), `OMNIFEX_DEV_DAEMON` marker and closed periodic-work gate. Untouched.
- Idle watch values are unchanged: 30 s grace after the last client (`30_000`), 2 min for a first connection (`120_000`), checked every 5 s (`5_000`), never while a turn is in flight.
- American spelling in code, comments, docs (`american-spelling.test.ts`).
- Never `npm start` to demo; never kill processes by pattern (see global CLAUDE.md).
- Two departures from the spec, both settled here: (a) no test for "`start` arms the idle watch" — arming becomes unconditional, so there is no branch left to pin; (b) the quit's stop budget is 6 s, not the spec's 2 s, so Quit & Reopen never meets a daemon still closing (Review Focus 1).

## Review Focus

1. **Quit & Reopen while the old daemon is still closing** — the relaunched app must not adopt a daemon that is on its way out. Expected: the app's quit waits for `stop` to finish (the stop command waits up to 5 s for the pid), so relaunch starts fresh. Pinned in Task 3 (`quitStopTimeout` > 5).
2. **The dev build quits** — must never stop the installed daemon. Expected: dev's stop always carries `--dev`; the packaged app's never does. Pinned in Task 3 (`stopArgs`).
3. **Force-quit mid-turn** — expected: the daemon finishes the turn, then exits 30 s later. Pinned in Task 1 (existing "never kills a turn that is still running", moved with the watch).
4. **App dies before its first connection** (crash at launch, or a `start` run by hand for a smoke test) — expected: the daemon exits after 2 min. Pinned in Task 1 (existing "exits when nothing ever connects", moved).
5. **`omnifex-server install` typed from habit** — expected: "unknown command", help, exit 2, no plist written. Pinned in Task 2.

---

### Task 1: The idle watch guards every daemon

**Files:**
- Create: `electron/remote/idle-watch.ts`
- Modify: `electron/remote/dev-instance.ts` (remove the watch and its constants; header no longer mentions it)
- Modify: `electron/omnifex-server.ts:32,35,188-204` (import, constant, arm unconditionally)
- Create: `electron/__tests__/remote-idle-watch.test.ts`
- Modify: `electron/__tests__/remote-dev-instance.test.ts` (remove the `createDevIdleWatch` block, lines 107–end of that describe)

**Interfaces:**
- Produces: `createIdleWatch(opts: { clients: () => number; inFlight: () => number; everConnected: () => boolean; startedAt: number; graceMs?: number; startupMs?: number }): IdleWatch`, `interface IdleWatch { check(nowMs: number): boolean }`, `IDLE_GRACE_MS = 30_000`, `STARTUP_GRACE_MS = 120_000`, `IDLE_CHECK_MS = 5_000` — all exported from `electron/remote/idle-watch.ts`.

- [ ] **Step 1: Create the branch** — `git checkout -b feat/daemon-dies-with-app`.

- [ ] **Step 2: Write the failing test.** Move the `createDevIdleWatch` describe block from `remote-dev-instance.test.ts` into `remote-idle-watch.test.ts` verbatim, renamed to `describe('createIdleWatch', …)`, importing `createIdleWatch, IDLE_GRACE_MS, STARTUP_GRACE_MS, IDLE_CHECK_MS` from `../remote/idle-watch`. Add:

```ts
it('keeps the values the dev daemon has always used', () => {
  expect(IDLE_GRACE_MS).toBe(30_000);
  expect(STARTUP_GRACE_MS).toBe(120_000);
  expect(IDLE_CHECK_MS).toBe(5_000);
});
```

- [ ] **Step 3: Run it to see it fail** — `npx vitest run electron/__tests__/remote-idle-watch.test.ts`. Expected: FAIL, cannot resolve `../remote/idle-watch`.

- [ ] **Step 4: Implement.** Move `createDevIdleWatch`, `DevIdleWatch`, `DEV_IDLE_GRACE_MS`, `DEV_STARTUP_GRACE_MS` out of `dev-instance.ts` into `idle-watch.ts` under the new names; move `DEV_IDLE_CHECK_MS` out of `omnifex-server.ts` as `IDLE_CHECK_MS`. Rewrite the doc comment: the watch is every daemon's backstop for an app that vanished without a clean quit; keep the paragraphs on `everConnected`, in-flight turns and the startup window. In `omnifex-server.ts` `start`, drop the `if (isDevDaemon(process.env))` around the watch so it is always armed; replace "Foreground forever; launchd owns the lifecycle." with "Foreground until the app stops it or the idle watch fires." Remove the now-unused `isDevDaemon` import there if nothing else uses it.

- [ ] **Step 5: Run the tests** — `npx vitest run electron/__tests__/remote-idle-watch.test.ts electron/__tests__/remote-dev-instance.test.ts` and `npm run check`. Expected: PASS, no type errors.

- [ ] **Step 6: Commit** — `git add electron/remote/idle-watch.ts electron/remote/dev-instance.ts electron/omnifex-server.ts electron/__tests__/remote-idle-watch.test.ts electron/__tests__/remote-dev-instance.test.ts && git commit -m "refactor(daemon): arm the idle watch in every daemon, not just dev"`

---

### Task 2: Spawn every daemon attached; delete launchd

**Files:**
- Delete: `electron/remote/launchd.ts`, `electron/__tests__/remote-launchd.test.ts`
- Modify: `electron/remote/daemon-control.ts` (whole file: drop launchd, `allowLaunchd`, `detached`, `managedByLaunchd`, `run`, `uid`; header rewritten)
- Modify: `electron/remote/cli.ts` (drop `launchdAllowed`, `installCommand`, `uninstallCommand`, `LaunchctlRunner`, `defaultLaunchctl`, `'install' | 'uninstall'` from `CliCommand` and `COMMANDS`, their `HELP` lines, launchd wording in the header, `stopCommand` doc and `--dev` help)
- Modify: `electron/omnifex-server.ts:15-25,96-112,158-162` (imports, `lifecycle()`, the two cases)
- Modify: `electron/remote/launcher.ts:1-20` (header: the daemon is the app's, stopped on quit; drop "launchd is the proper owner")
- Modify: `scripts/dev.ts:16` (comment no longer contrasts with a LaunchAgent)
- Test: `electron/__tests__/remote-daemon-control.test.ts`, `electron/__tests__/remote-cli-lifecycle.test.ts`

**Interfaces:**
- Produces: `interface DaemonInvocation { execPath: string; script: string }` and `defaultLogPath(home?: string): string` (unchanged value `~/Library/Logs/omnifex-server.log`), both now exported from `daemon-control.ts`. `DaemonControlDeps` loses `allowLaunchd`, `detached`, `run`, `uid`; `spawnDetached` is renamed `spawnDaemon(invocation, logPath, env): number | null` (no opts). `DaemonControl` is `{ stop(config): Promise<boolean>; spawn(config): boolean }`.

- [ ] **Step 1: Write the failing tests.** In `remote-daemon-control.test.ts` (add `existsSync` to the `node:fs` import): delete the `(LaunchAgent installed)` describe and the launchd parts of `make()` (`plist`, `allowLaunchd`, `detached`, `run`, `launchAgentPath` import); rename `spawnDetached` → `spawnDaemon`; rename the describe to `'daemon control'`; replace the two spawn tests (`'spawn starts the script detached…'`, `'spawns in the caller's process group when asked not to detach'`) with:

```ts
it('spawns the daemon in the caller\'s process group, logging to ~/Library/Logs', () => {
  const { control, spawnDaemon } = make();
  expect(control.spawn(CONFIG)).toBe(true);
  expect(spawnDaemon).toHaveBeenCalledTimes(1);
  const [inv, logPath, , ...rest] = spawnDaemon.mock.calls[0];
  expect(inv).toEqual(INVOCATION);
  expect(logPath).toBe(join(home, 'Library', 'Logs', 'omnifex-server.log'));
  expect(rest).toEqual([]); // no detached option left to pass
});

it('never writes a LaunchAgent', () => {
  make().control.spawn(CONFIG);
  expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
});
```

In `remote-cli-lifecycle.test.ts`: delete the `launchdAllowed` describe; add

```ts
it('no longer knows install or uninstall', () => {
  expect(parseCliArgs(['install'])).toEqual({ command: 'help', flags: {}, unknown: 'install' });
  expect(parseCliArgs(['uninstall'])).toEqual({ command: 'help', flags: {}, unknown: 'uninstall' });
  expect(HELP).not.toMatch(/LaunchAgent|launchd|install/);
});
```

- [ ] **Step 2: Run them to see them fail** — `npx vitest run electron/__tests__/remote-daemon-control.test.ts electron/__tests__/remote-cli-lifecycle.test.ts`. Expected: FAIL (`spawnDaemon` not a dep, extra opts argument, `install` parsed as a command).

- [ ] **Step 3: Implement.** In `daemon-control.ts`, `defaultSpawnDaemon` calls `spawnChild(execPath, [script, 'start'], { detached: false, stdio: ['ignore', fd, fd], env })` then `child.unref()`; `stop` is the pid-file SIGTERM branch alone; `spawn` is the script-exists check then `spawnDaemon`. Header: one way a daemon runs now — spawned by `ensure` into the app's process group, stopped by the app on quit, the idle watch as backstop. In `omnifex-server.ts` `lifecycle()`, `createDaemonControl({ invocation, env, log })` — the `allowLaunchd` and `detached` lines and their comment go. Delete `launchd.ts` and its test.

- [ ] **Step 4: Run the tests** — `npx vitest run electron/__tests__/remote-daemon-control.test.ts electron/__tests__/remote-cli-lifecycle.test.ts`, then `npm run check`, then `rg -n "launchd|LaunchAgent|allowLaunchd|managedByLaunchd|installCommand" electron scripts src`. Expected: PASS, no type errors, the `rg` finds only `fixPath`'s comment in `daemon.ts:157` and `spawn.ts:39` (both about launchd's minimal PATH — reword each to "a GUI-launched process" since launchd no longer launches the daemon).

- [ ] **Step 5: Commit** — `git add -A electron scripts/dev.ts && git commit -m "feat(daemon): spawn every daemon in the app's process group; remove the LaunchAgent"`

---

### Task 3: The Mac app stops its daemon on quit

**Files:**
- Create: `macos/Sources/OmniFexCore/DaemonCLI.swift`
- Delete: `macos/Sources/OmniFexCore/LauncherProcessGroup.swift`'s `forDaemonCLI` (keep the enum: `Spawn.output` uses it); `macos/Tests/OmniFexCoreTests/LauncherProcessGroupTests.swift`
- Create: `macos/Tests/OmniFexCoreTests/DaemonCLITests.swift`
- Modify: `macos/Sources/OmniFex/DaemonLauncher.swift:1-10,56,85-92` (header; `group: .callers`; `stop`/`stopSync` use `DaemonCLI.stopArgs`)
- Modify: `macos/Sources/OmniFex/AppServices.swift:149-154` (`willTerminate`)
- Modify: `macos/Sources/OmniFex/OmniFexApp.swift:34-37` (comment: closing the last window now ends the sessions too)
- Modify: `CLAUDE.md` ("The Shape of the App": Daemon bullet, the dev-instance rule, delete "The LaunchAgent belongs to the real instance" rule), `docs/remote-access.md` (lifetime, install/uninstall), `macos/README.md` if it describes the daemon outliving the app

**Interfaces:**
- Produces (OmniFexCore): `public enum DaemonCLI { public static func stopArgs(_ paths: AppPaths) -> [String]; public static let group: LauncherProcessGroup; public static let quitStopTimeout: TimeInterval }`.

- [ ] **Step 1: Write the failing test** in `DaemonCLITests.swift`:

```swift
@Suite struct DaemonCLITests {
    let dev = AppPaths(environment: ["HOME": "/h", "OMNIFEX_DEV_SERVER_URL": "http://localhost:5173/"], bundlePath: "/b")
    let packaged = AppPaths(environment: ["HOME": "/h"], bundlePath: "/b")

    // The dev build can never stop the installed daemon: --dev points stop at
    // ~/.omnifex-dev's pid file, and only the packaged app omits it.
    @Test func devStopTargetsTheDevInstance() { #expect(DaemonCLI.stopArgs(dev) == ["stop", "--dev"]) }
    @Test func packagedStopTargetsTheRealInstance() { #expect(DaemonCLI.stopArgs(packaged) == ["stop"]) }

    // Every daemon belongs to the app that started it.
    @Test func everyDaemonJoinsTheAppsGroup() { #expect(DaemonCLI.group == .callers) }

    // `omnifex-server stop` waits up to 5s for the pid to exit; the quit must
    // outwait it, or Quit & Reopen can adopt a daemon that is still closing.
    @Test func quitOutwaitsTheStopCommand() { #expect(DaemonCLI.quitStopTimeout > 5) }
}
```

- [ ] **Step 2: Run it to see it fail** — `npm run test:swift`. Expected: FAIL, `DaemonCLI` not found.

- [ ] **Step 3: Implement.** `DaemonCLI.stopArgs` returns `["stop"] + (paths.isDev ? ["--dev"] : [])`; `group = .callers`; `quitStopTimeout = 6`. Remove `forDaemonCLI` and its tests file; update `LauncherProcessGroup`'s doc comment (daemon CLI always joins the caller's group; `.own` remains `Spawn.output`'s default for other children). In `DaemonLauncher`, `run` and `stop` pass `group: DaemonCLI.group`; `stop(timeout:)` and `stopSync(timeout:)` both build args from `DaemonCLI.stopArgs(paths)`. `AppServices.willTerminate` calls `daemon.stopSync(timeout: DaemonCLI.quitStopTimeout)` unconditionally; its comment says the daemon lives and dies with the app.

- [ ] **Step 4: Update the docs** listed under Files: the daemon is the app's child — started by `ensure` at launch, stopped on quit, idle watch as backstop; no LaunchAgent; the iPad reaches it only while the Mac app runs; quitting ends sessions (the "Quit anyway?" prompt guards a running turn). Keep the dev-instance rule's isolation facts (own port, state dir, `--dev`, closed periodic gate).

- [ ] **Step 5: Run the gate** — `bash .claude/skills/verify/scripts/verify.sh`. Expected: `PASS` for `npm run check`, `npm run build`, `npm run test:coverage`, `npm run test:swift`.

- [ ] **Step 6: Commit** — `git add macos CLAUDE.md docs/remote-access.md && git commit -m "feat(macos): stop the daemon when the app quits"`

- [ ] **Step 7: Packaged smoke check** — `npm run package`, then launch `out/OmniFex-darwin-arm64/OmniFex.app` with `OMNIFEX_STATE_DIR`, `OMNIFEX_USER_DATA_DIR` pointed at a scratch dir and `OMNIFEX_PORT=47790`; confirm with `pgrep -lf "personal/omnifex/out/OmniFex-darwin-arm64"` (the build's own path — unique to this run, unlike the scratch dir, which is in the environment, not the command line) that one daemon appears; quit the app; confirm the same `pgrep` finds nothing within 6 s. Expected: daemon gone after quit. Do not touch Greg's running app or its daemon.
