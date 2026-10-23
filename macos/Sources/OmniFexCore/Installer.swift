import Foundation

/// An install failure the renderer can show. `message` is `"Name: detail"`;
/// the titlebar matches on the name (`WaitCancelled` is a user choice, not an
/// error).
public struct InstallError: Error, LocalizedError, Equatable {
    public var name: String
    public var detail: String
    public var message: String { "\(name): \(detail)" }
    public var errorDescription: String? { message }

    public init(name: String, detail: String) {
        self.name = name
        self.detail = detail
    }

    static func fileNotFound(_ p: String) -> Self { .init(name: "UpdateFileNotFound", detail: p) }
    static func invalidPackage(_ why: String) -> Self { .init(name: "InvalidUpdatePackage", detail: why) }
    static func versionMismatch(_ expected: String, _ actual: String) -> Self {
        .init(name: "VersionMismatch", detail: "expected \(expected), got \(actual)")
    }
    static let notPackaged = Self(name: "NotPackaged", detail: "this build is not running from an .app bundle")
    static func targetNotWritable(_ p: String) -> Self { .init(name: "TargetNotWritable", detail: p) }
    static let waitCancelled = Self(name: "WaitCancelled", detail: "the user cancelled the wait")
}

/// Builds the shell script that runs after the app quits, swaps the bundle in
/// place and relaunches. Pure, so the quoting rules are testable.
public enum HelperScript {
    public static func build(parentPid: Int32, targetAppPath: String, stagedAppPath: String) throws -> String {
        // Defence in depth: these paths come from the bundle and the temp dir,
        // never from a user, but they are interpolated into shell.
        let dangerous = CharacterSet(charactersIn: "\"`\\\n\r\t\0$")
        for p in [targetAppPath, stagedAppPath] where p.rangeOfCharacter(from: dangerous) != nil {
            throw InstallError(name: "InvalidUpdatePackage", detail: "helper-script: refusing path containing shell-unsafe character")
        }
        // The stage dir is the mkdtemp folder `stage` made and holds nothing but
        // the staged app. Remove it whole — but only when it is recognisably
        // ours, so some other layout never gets its parent deleted.
        let stageDir = (stagedAppPath as NSString).deletingLastPathComponent
        let removeStaged = (stageDir as NSString).lastPathComponent.hasPrefix("omnifex-stage-")
            ? "rm -rf \"\(stageDir)\""
            : "rm -rf \"$STAGED_APP\""
        return [
            "#!/bin/sh",
            "PARENT_PID=\(parentPid)",
            "TARGET_APP=\"\(targetAppPath)\"",
            "STAGED_APP=\"\(stagedAppPath)\"",
            "SELF=$0",
            "",
            "while kill -0 \"$PARENT_PID\" 2>/dev/null; do sleep 0.2; done",
            "",
            "rm -rf \"$TARGET_APP\" || exit 1",
            "ditto \"$STAGED_APP\" \"$TARGET_APP\" || exit 1",
            "open \"$TARGET_APP\"",
            "",
            removeStaged,
            "rm -f \"$SELF\"",
            "",
        ].joined(separator: "\n")
    }
}

/// Stages, validates and gates an update. The app target does the two side
/// effects that end the process — stopping the daemon and spawning the helper.
public final class Installer: @unchecked Sendable {
    public typealias Extract = (_ zipPath: String, _ destDir: String) async throws -> Void

    private let tmpdir: String
    private let extract: Extract
    private let readBundleVersion: (String) -> String?
    private let lock = NSLock()
    private var cancelToken: CancelToken?

    final class CancelToken: @unchecked Sendable { var cancelled = false }

    public init(tmpdir: String, extract: @escaping Extract, readBundleVersion: @escaping (String) -> String?) {
        self.tmpdir = tmpdir
        self.extract = extract
        self.readBundleVersion = readBundleVersion
    }

    /// `CFBundleShortVersionString` from a bundle's Info.plist.
    public static func bundleVersion(_ appPath: String) -> String? {
        let plist = URL(fileURLWithPath: appPath).appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plist),
              let obj = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return obj["CFBundleShortVersionString"] as? String
    }

    public func stage(zipPath: String, expectedVersion: String) async throws -> String {
        let fm = FileManager.default
        guard fm.fileExists(atPath: zipPath) else { throw InstallError.fileNotFound(zipPath) }

        let template = (tmpdir as NSString).appendingPathComponent("omnifex-stage-XXXXXX")
        var buf = Array(template.utf8CString)
        guard mkdtemp(&buf) != nil else { throw InstallError.invalidPackage("could not create a stage dir") }
        let dest = String(cString: buf)
        func discard() { try? fm.removeItem(atPath: dest) }

        do {
            try await extract(zipPath, dest)
        } catch {
            discard()
            throw InstallError.invalidPackage("extraction failed: \(error.localizedDescription)")
        }
        let staged = dest + "/OmniFex.app"
        guard fm.fileExists(atPath: staged + "/Contents/MacOS/OmniFex") else {
            discard()
            throw InstallError.invalidPackage("OmniFex.app/Contents/MacOS/OmniFex not found in archive")
        }
        let actual = readBundleVersion(staged)
        guard actual == expectedVersion else {
            discard()
            throw InstallError.versionMismatch(expectedVersion, actual ?? "<unreadable>")
        }
        return staged
    }

    /// `/Applications/OmniFex.app/Contents/MacOS/OmniFex` → `/Applications/OmniFex.app`.
    public static func resolveTargetApp(executablePath: String) throws -> String {
        var cur = executablePath
        while cur != "/" && !cur.isEmpty {
            if cur.hasSuffix(".app") { return cur }
            cur = (cur as NSString).deletingLastPathComponent
        }
        throw InstallError.notPackaged
    }

    public static func ensureTargetWritable(_ targetAppPath: String) throws {
        let parent = (targetAppPath as NSString).deletingLastPathComponent
        guard FileManager.default.isWritableFile(atPath: parent) else { throw InstallError.targetNotWritable(parent) }
    }

    public func cancelWait() {
        lock.withLock { cancelToken?.cancelled = true }
    }

    /// Wait until nothing is in flight, then report `installing`.
    ///
    /// `force` ("Install anyway") never enters the loop. It used to stop the
    /// local sessions and poll anyway, but the daemon owns the sessions and
    /// keeps reporting them, so the override hung forever — failing exactly
    /// when it was needed.
    public func waitForIdle(
        force: Bool,
        localBusy: () -> [String],
        remoteInFlight: () async -> Int?,
        emit: ([String: Any]) -> Void,
        sleep: (UInt64) async -> Void
    ) async throws {
        if force {
            lock.withLock { cancelToken = nil }
            emit(["phase": "installing"])
            return
        }
        let token = CancelToken()
        lock.withLock { cancelToken = token }
        while true {
            let cancelled = lock.withLock { token.cancelled }
            if cancelled {
                lock.withLock { if cancelToken === token { cancelToken = nil } }
                throw InstallError.waitCancelled
            }
            let local = localBusy()
            // Not double-counted: a local tab and the daemon may both report
            // the same turn, but the gate only asks "is anything running".
            let remote = await remoteInFlight() ?? 0
            let sessions = max(local.count, remote)
            if sessions == 0 {
                lock.withLock { if cancelToken === token { cancelToken = nil } }
                emit(["phase": "installing"])
                return
            }
            emit(["phase": "waiting", "activeSessions": sessions, "tabs": local.map { ["tabId": $0, "sessionStatus": "busy"] }])
            await sleep(1_000_000_000)
        }
    }
}
