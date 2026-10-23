import AppKit
import WebKit
import OmniFexCore

/// Updates from GitHub releases: check, download with progress, install by
/// swapping the bundle in place and relaunching. The same zip asset every
/// earlier OmniFex installs, Electron builds included.
@MainActor
final class UpdateController: NSObject {
    private unowned let services: AppServices
    private lazy var installer = Installer(
        tmpdir: NSTemporaryDirectory(),
        extract: { zip, dest in
            let out = try await Spawn.output("/usr/bin/ditto", ["-xk", zip, dest], timeout: 300)
            guard out.status == 0 else { throw BridgeError("ditto exited \(out.status)") }
        },
        readBundleVersion: Installer.bundleVersion
    )

    init(services: AppServices) { self.services = services }

    /// Anything unreachable or unreadable is "no update" — the titlebar shows
    /// "up to date" rather than an error spinner.
    func check() async -> Any? {
        var req = URLRequest(url: Updater.latestReleaseURL())
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("OmniFex-Updater", forHTTPHeaderField: "User-Agent")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return Updater.pickUpdate(fromRelease: data, currentVersion: services.version)?.json
    }

    func download(url raw: String, assetName: String?, to webView: WKWebView?) async throws -> String {
        guard let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else {
            throw BridgeError("updater:download: bad url")
        }
        let dest = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(assetName ?? Updater.filename(fromURL: raw))
        let delegate = DownloadProgress { bytes, total in
            Task { @MainActor in
                if let webView { Bridge.emit("updater:progress", Updater.progress(bytes: bytes, total: total), to: webView) }
            }
        }
        let (tmp, response) = try await URLSession.shared.download(from: url, delegate: delegate)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw BridgeError("download failed: HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest.path
    }

    /// The manual fallback: open the file (a DMG mounts) and quit so the user
    /// can drag-install.
    func open(_ path: String) throws {
        guard NSWorkspace.shared.open(URL(fileURLWithPath: path)) else { throw BridgeError("Could not open \(path)") }
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.services.quitAuthorizedNow() }
        }
    }

    func install(zipPath: String, version: String, force: Bool) async throws {
        let staged = try await installer.stage(zipPath: zipPath, expectedVersion: version)
        do {
            guard let exe = Bundle.main.executablePath else { throw InstallError(name: "NotPackaged", detail: "no executable path") }
            let target = try Installer.resolveTargetApp(executablePath: exe)
            try Installer.ensureTargetWritable(target)
            try await installer.waitForIdle(
                force: force,
                localBusy: { services.tabStatus.busyTabIds() },
                remoteInFlight: { await self.services.daemon.remoteInFlight() },
                emit: { services.broadcast("updater:install-status", $0) },
                sleep: { try? await Task.sleep(nanoseconds: $0) }
            )
            // Before the helper exists: it waits for this process to exit and
            // then deletes the bundle the daemon is running from. The new app
            // starts a fresh daemon; sessions resume on their next message.
            await services.daemon.stop(timeout: 5)
            let script = try HelperScript.build(parentPid: getpid(), targetAppPath: target, stagedAppPath: staged)
            let helper = (NSTemporaryDirectory() as NSString).appendingPathComponent("omnifex-installer-\(Int(Date().timeIntervalSince1970 * 1000)).sh")
            try script.write(toFile: helper, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper)
            try Spawn.detached("/bin/sh", [helper])
            services.quitAuthorizedNow()
        } catch {
            try? FileManager.default.removeItem(atPath: (staged as NSString).deletingLastPathComponent)
            throw error
        }
    }

    func cancelInstall() { installer.cancelWait() }

    /// Downloaded zips at or below the running version are spent.
    func pruneDownloads() {
        let dir = NSTemporaryDirectory()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        for name in names where Updater.shouldPrune(name, currentVersion: services.version) {
            try? FileManager.default.removeItem(atPath: (dir as NSString).appendingPathComponent(name))
        }
    }
}

private final class DownloadProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let onProgress: (Int64, Int64) -> Void
    init(_ onProgress: @escaping (Int64, Int64) -> Void) { self.onProgress = onProgress }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        onProgress(totalBytesWritten, max(0, totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}
