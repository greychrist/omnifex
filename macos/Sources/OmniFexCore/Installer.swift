import Foundation

/// `message` is `"Name: detail"`; the titlebar matches on the name.
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

public enum HelperScript {
    public static func build(parentPid: Int32, targetAppPath: String, stagedAppPath: String) throws -> String {
        // These paths never come from a user, but they are interpolated into shell.
        let dangerous = CharacterSet(charactersIn: "\"`\\\n\r\t\0$")
        for p in [targetAppPath, stagedAppPath] where p.rangeOfCharacter(from: dangerous) != nil {
            throw InstallError(name: "InvalidUpdatePackage", detail: "helper-script: refusing path containing shell-unsafe character")
        }
        // Remove the stage dir whole only when it is recognizably ours, so another layout never loses its parent.
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

    /// `force` never enters the loop: the daemon keeps reporting its sessions, so polling would hang forever.
    /// `localBusy` and `emit` run on the main actor: WebKit kills the process on an off-main call.
    public func waitForIdle(
        force: Bool,
        localBusy: @MainActor () -> [String],
        remoteInFlight: () async -> Int?,
        emit: @MainActor ([String: Any]) -> Void,
        sleep: (UInt64) async -> Void
    ) async throws {
        if force {
            lock.withLock { cancelToken = nil }
            await emit(["phase": "installing"])
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
            let local = await localBusy()
            // max, not sum: a local tab and the daemon may report the same turn.
            let remote = await remoteInFlight() ?? 0
            let sessions = max(local.count, remote)
            if sessions == 0 {
                lock.withLock { if cancelToken === token { cancelToken = nil } }
                await emit(["phase": "installing"])
                return
            }
            await emit(["phase": "waiting", "activeSessions": sessions, "tabs": local.map { ["tabId": $0, "sessionStatus": "busy"] }])
            await sleep(1_000_000_000)
        }
    }
}
