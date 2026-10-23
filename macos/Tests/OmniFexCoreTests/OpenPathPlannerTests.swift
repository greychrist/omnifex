import Foundation
import Testing
@testable import OmniFexCore

@Suite struct OpenPathPlannerTests {
    let home = "/Users/me"
    let cwd = "/Users/me/Repos/work/management"

    @Test func resolvesRelativeAgainstCwd() {
        #expect(OpenPathPlanner.resolveLinkPath("reports/draft.md", cwd: cwd, homeDir: home) == "\(cwd)/reports/draft.md")
    }
    @Test func keepsAbsolute() {
        #expect(OpenPathPlanner.resolveLinkPath("/tmp/a.md", cwd: cwd, homeDir: home) == "/tmp/a.md")
        #expect(OpenPathPlanner.resolveLinkPath("/tmp/x/../a.md", cwd: cwd, homeDir: home) == "/tmp/a.md")
    }
    @Test func expandsTilde() {
        #expect(OpenPathPlanner.resolveLinkPath("~/notes.md", cwd: nil, homeDir: home) == "/Users/me/notes.md")
        #expect(OpenPathPlanner.resolveLinkPath("~", cwd: nil, homeDir: home) == "/Users/me")
    }
    @Test func stripsLineSuffix() {
        #expect(OpenPathPlanner.resolveLinkPath("src/foo.ts:42", cwd: cwd, homeDir: home) == "\(cwd)/src/foo.ts")
        #expect(OpenPathPlanner.resolveLinkPath("src/foo.ts:42:7", cwd: cwd, homeDir: home) == "\(cwd)/src/foo.ts")
    }
    @Test func decodesPercentEncoding() {
        #expect(OpenPathPlanner.resolveLinkPath("/tmp/my%20file.md", cwd: nil, homeDir: home) == "/tmp/my file.md")
    }
    @Test func acceptsFileURL() {
        #expect(OpenPathPlanner.resolveLinkPath("file:///tmp/a.md", cwd: nil, homeDir: home) == "/tmp/a.md")
    }
    @Test func nilWithoutCwdOrInput() {
        #expect(OpenPathPlanner.resolveLinkPath("reports/draft.md", cwd: nil, homeDir: home) == nil)
        #expect(OpenPathPlanner.resolveLinkPath("  ", cwd: cwd, homeDir: home) == nil)
    }

    func file(_ mode: Int = 0o644) -> OpenPathPlanner.PathStat { .init(isDirectory: false, mode: mode) }
    let dir = OpenPathPlanner.PathStat(isDirectory: true, mode: 0o755)

    @Test func opensADocumentAndAFolder() {
        #expect(OpenPathPlanner.plan("reports/draft.md", cwd: cwd, homeDir: home, stat: { _ in file() }) == .open("\(cwd)/reports/draft.md"))
        #expect(OpenPathPlanner.plan("/tmp/x", cwd: nil, homeDir: home, stat: { _ in dir }) == .open("/tmp/x"))
    }
    @Test func reportsMissingAndUnresolvable() {
        #expect(OpenPathPlanner.plan("reports/gone.md", cwd: cwd, homeDir: home, stat: { _ in nil }) == .error("File not found: \(cwd)/reports/gone.md"))
        if case .error = OpenPathPlanner.plan("reports/draft.md", cwd: nil, homeDir: home, stat: { _ in file() }) {} else { Issue.record("expected error") }
    }
    // Claude writes these paths. A click must never run something.
    @Test func revealsExecutables() {
        #expect(OpenPathPlanner.plan("/tmp/run", cwd: nil, homeDir: home, stat: { _ in file(0o755) }) == .reveal("/tmp/run"))
    }
    @Test(arguments: ["x.app", "x.command", "x.sh", "x.terminal", "x.workflow", "x.pkg", "x.scpt", "x.py", "x.jar", "X.SH"])
    func revealsRunnableExtensions(_ name: String) {
        let stat: (String) -> OpenPathPlanner.PathStat? = { _ in name.hasSuffix(".app") ? dir : file() }
        #expect(OpenPathPlanner.plan("/tmp/\(name)", cwd: nil, homeDir: home, stat: stat) == .reveal("/tmp/\(name)"))
    }
}
