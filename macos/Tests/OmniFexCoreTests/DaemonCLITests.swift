import Testing
@testable import OmniFexCore

@Suite struct DaemonCLITests {
    let dev = AppPaths(environment: ["HOME": "/h", "OMNIFEX_DEV_SERVER_URL": "http://localhost:5173/"], bundlePath: "/b")
    let packaged = AppPaths(environment: ["HOME": "/h"], bundlePath: "/b")

    @Test func devStopTargetsTheDevInstance() { #expect(DaemonCLI.stopArgs(dev) == ["stop", "--dev"]) }
    @Test func packagedStopTargetsTheRealInstance() { #expect(DaemonCLI.stopArgs(packaged) == ["stop"]) }

    @Test func everyDaemonJoinsTheAppsGroup() { #expect(DaemonCLI.group == .callers) }

    @Test func quitOutwaitsTheStopCommand() { #expect(DaemonCLI.quitStopTimeout > 5) }
}
