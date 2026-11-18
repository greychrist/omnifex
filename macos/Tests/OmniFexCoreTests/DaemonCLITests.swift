import Testing
@testable import OmniFexCore

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
