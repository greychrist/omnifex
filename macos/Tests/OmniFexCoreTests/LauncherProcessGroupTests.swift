import Testing
@testable import OmniFexCore

@Suite struct LauncherProcessGroupTests {
    @Test func devJoinsTheAppsGroup() {
        let paths = AppPaths(environment: ["HOME": "/h", "OMNIFEX_DEV_SERVER_URL": "http://localhost:5173/"], bundlePath: "/b")
        #expect(LauncherProcessGroup.forDaemonCLI(paths) == .callers)
    }
    @Test func packagedGetsItsOwnGroup() {
        let paths = AppPaths(environment: ["HOME": "/h"], bundlePath: "/b")
        #expect(LauncherProcessGroup.forDaemonCLI(paths) == .own)
    }
}
