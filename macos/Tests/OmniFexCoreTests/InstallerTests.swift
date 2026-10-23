import Foundation
import Testing
@testable import OmniFexCore

@Suite struct HelperScriptTests {
    @Test func substitutesPathsAndPid() throws {
        let s = try HelperScript.build(parentPid: 12345, targetAppPath: "/Applications/OmniFex.app", stagedAppPath: "/tmp/stage/OmniFex.app")
        #expect(s.hasPrefix("#!/bin/sh"))
        #expect(s.contains("PARENT_PID=12345"))
        #expect(s.contains("TARGET_APP=\"/Applications/OmniFex.app\""))
        #expect(s.contains("STAGED_APP=\"/tmp/stage/OmniFex.app\""))
        #expect(s.contains("while kill -0 \"$PARENT_PID\""))
        #expect(s.contains("rm -rf \"$TARGET_APP\""))
        #expect(s.contains("ditto \"$STAGED_APP\" \"$TARGET_APP\""))
        #expect(s.contains("open \"$TARGET_APP\""))
        #expect(s.contains("rm -f \"$SELF\""))
    }

    // The stage dir holds only the staged app; removing just the app left an
    // empty omnifex-stage-* folder behind per install.
    @Test func removesTheWholeStageDirAfterOpening() throws {
        let s = try HelperScript.build(parentPid: 1, targetAppPath: "/Applications/OmniFex.app", stagedAppPath: "/var/T/omnifex-stage-AbC123/OmniFex.app")
        let rm = try #require(s.range(of: "rm -rf \"/var/T/omnifex-stage-AbC123\""))
        let open = try #require(s.range(of: "open \"$TARGET_APP\""))
        #expect(open.lowerBound < rm.lowerBound)
    }

    @Test func neverRemovesANonStageParent() throws {
        let s = try HelperScript.build(parentPid: 1, targetAppPath: "/Applications/OmniFex.app", stagedAppPath: "/tmp/OmniFex.app")
        #expect(!s.contains("rm -rf \"/tmp\""))
        #expect(s.contains("rm -rf \"$STAGED_APP\""))
    }

    @Test(arguments: ["/A/Bad\"N.app", "/A/Bad$N.app", "/A/Bad`N.app", "/A/Bad\nN.app", "/A/Bad\\N.app"])
    func refusesShellUnsafePaths(_ bad: String) {
        #expect(throws: (any Error).self) { try HelperScript.build(parentPid: 1, targetAppPath: bad, stagedAppPath: "/tmp/x") }
        #expect(throws: (any Error).self) { try HelperScript.build(parentPid: 1, targetAppPath: "/A/Good.app", stagedAppPath: bad) }
    }
}

@Suite struct InstallerTests {
    func tmp() throws -> String {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("inst-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }

    func installer(tmpdir: String, extract: @escaping Installer.Extract = { _, _ in }, version: @escaping (String) -> String? = { _ in "0.5.0" }) -> Installer {
        Installer(tmpdir: tmpdir, extract: extract, readBundleVersion: version)
    }

    func fakeApp(_ dest: String) throws {
        let mac = dest + "/OmniFex.app/Contents/MacOS"
        try FileManager.default.createDirectory(atPath: mac, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: mac + "/OmniFex", contents: Data("bin".utf8))
    }

    @Test func missingZip() async throws {
        let t = try tmp()
        await #expect(throws: InstallError.self) { try await installer(tmpdir: t).stage(zipPath: t + "/nope.zip", expectedVersion: "0.5.0") }
        do { _ = try await installer(tmpdir: t).stage(zipPath: t + "/nope.zip", expectedVersion: "0.5.0") }
        catch let e as InstallError { #expect(e.name == "UpdateFileNotFound"); #expect(e.message.hasPrefix("UpdateFileNotFound: ")) }
    }

    @Test func noAppInArchive() async throws {
        let t = try tmp()
        FileManager.default.createFile(atPath: t + "/a.zip", contents: Data())
        do { _ = try await installer(tmpdir: t).stage(zipPath: t + "/a.zip", expectedVersion: "0.5.0"); Issue.record("should throw") }
        catch let e as InstallError { #expect(e.name == "InvalidUpdatePackage") }
        // The failed stage dir is cleaned up.
        #expect(try FileManager.default.contentsOfDirectory(atPath: t).filter { $0.hasPrefix("omnifex-stage-") }.isEmpty)
    }

    @Test func extractionFailure() async throws {
        let t = try tmp()
        FileManager.default.createFile(atPath: t + "/a.zip", contents: Data())
        let i = installer(tmpdir: t, extract: { _, _ in throw NSError(domain: "ditto", code: 1) })
        do { _ = try await i.stage(zipPath: t + "/a.zip", expectedVersion: "0.5.0"); Issue.record("should throw") }
        catch let e as InstallError { #expect(e.name == "InvalidUpdatePackage") }
    }

    @Test func versionMismatch() async throws {
        let t = try tmp()
        FileManager.default.createFile(atPath: t + "/a.zip", contents: Data())
        let i = installer(tmpdir: t, extract: { _, dest in try self.fakeApp(dest) }, version: { _ in nil })
        do { _ = try await i.stage(zipPath: t + "/a.zip", expectedVersion: "0.5.0"); Issue.record("should throw") }
        catch let e as InstallError { #expect(e.name == "VersionMismatch"); #expect(e.message.contains("<unreadable>")) }
    }

    @Test func stagesAValidPackage() async throws {
        let t = try tmp()
        FileManager.default.createFile(atPath: t + "/a.zip", contents: Data())
        let i = installer(tmpdir: t, extract: { _, dest in try self.fakeApp(dest) })
        let staged = try await i.stage(zipPath: t + "/a.zip", expectedVersion: "0.5.0")
        #expect(staged.hasSuffix("/OmniFex.app"))
        #expect(staged.contains("/omnifex-stage-"))
        #expect(staged.hasPrefix(t))
    }

    @Test func resolvesTheTargetApp() throws {
        #expect(try Installer.resolveTargetApp(executablePath: "/Applications/OmniFex.app/Contents/MacOS/OmniFex") == "/Applications/OmniFex.app")
        #expect(throws: InstallError.self) { try Installer.resolveTargetApp(executablePath: "/usr/local/bin/omnifex") }
    }

    @Test func writability() throws {
        let t = try tmp()
        try Installer.ensureTargetWritable(t + "/OmniFex.app")
        #expect(throws: InstallError.self) { try Installer.ensureTargetWritable("/no/such/dir/OmniFex.app") }
    }

    final class Box: @unchecked Sendable { var statuses: [[String: Any]] = []; var n = 0 }

    @Test func installsAtOnceWhenIdle() async throws {
        let box = Box()
        try await installer(tmpdir: try tmp()).waitForIdle(force: false, localBusy: { [] }, remoteInFlight: { nil }, emit: { box.statuses.append($0) }, sleep: { _ in })
        #expect(box.statuses.map { $0["phase"] as? String } == ["installing"])
    }

    @Test func waitsWhileLocalOrRemoteIsBusy() async throws {
        let box = Box()
        try await installer(tmpdir: try tmp()).waitForIdle(
            force: false,
            localBusy: { box.n < 2 ? ["a"] : [] },
            // The daemon has a turn no local tab reports, for one more poll.
            remoteInFlight: { box.n < 3 ? 1 : 0 },
            emit: { box.statuses.append($0) },
            sleep: { _ in box.n += 1 })
        #expect(box.statuses.map { $0["phase"] as? String } == ["waiting", "waiting", "waiting", "installing"])
        #expect(box.statuses.first?["activeSessions"] as? Int == 1)
    }

    // "Install anyway" must never enter the poll loop: the daemon keeps
    // reporting its sessions, and the override used to hang forever.
    @Test func forceInstallsImmediately() async throws {
        let box = Box()
        try await installer(tmpdir: try tmp()).waitForIdle(force: true, localBusy: { ["a"] }, remoteInFlight: { 5 }, emit: { box.statuses.append($0) }, sleep: { _ in })
        #expect(box.statuses.map { $0["phase"] as? String } == ["installing"])
    }

    @Test func cancelRejectsTheWait() async throws {
        let i = installer(tmpdir: try tmp())
        let box = Box()
        do {
            try await i.waitForIdle(force: false, localBusy: { ["a"] }, remoteInFlight: { nil }, emit: { _ in }, sleep: { _ in
                box.n += 1
                if box.n == 2 { i.cancelWait() }
            })
            Issue.record("should throw")
        } catch let e as InstallError {
            #expect(e.name == "WaitCancelled")
        }
    }

    // `emit` reaches WKWebView and `localBusy` reads main-actor tab state. The
    // gate runs on the cooperative pool, so it must hop to the main actor for
    // both: emitting off-main made WebKit kill the app on every Install click.
    @Test(arguments: [false, true])
    func callsTabStateAndEmitOnTheMainThread(force: Bool) async throws {
        let i = installer(tmpdir: try tmp())
        final class Seen: @unchecked Sendable { var threads: [Bool] = [] }
        let seen = Seen()
        try await Task.detached {
            try await i.waitForIdle(
                force: force,
                localBusy: { seen.threads.append(Thread.isMainThread); return [] },
                remoteInFlight: { nil },
                emit: { _ in seen.threads.append(Thread.isMainThread) },
                sleep: { _ in })
        }.value
        #expect(!seen.threads.isEmpty)
        #expect(seen.threads.allSatisfy { $0 })
    }

    @Test func forceIsNotDefeatedByAnEarlierCancel() async throws {
        let i = installer(tmpdir: try tmp())
        i.cancelWait()
        try await i.waitForIdle(force: true, localBusy: { ["a"] }, remoteInFlight: { nil }, emit: { _ in }, sleep: { _ in })
        try await i.waitForIdle(force: false, localBusy: { [] }, remoteInFlight: { nil }, emit: { _ in }, sleep: { _ in })
    }
}
