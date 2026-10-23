import Foundation
import OmniFexCore

/// Starts, finds and stops the daemon — by asking the daemon's own CLI.
///
/// The rules for that (replace a daemon from another build, but only once its
/// turns are done; drive the LaunchAgent when one owns it; a dev build never
/// retires the installed app's daemon) live in TypeScript with their tests
/// (`remote-launcher.ts`, `daemon-control.ts`). Re-typing them in Swift would
/// be a second copy to drift, so this runs `omnifexd omnifex-server.js ensure`
/// and reads one line of JSON back.
@MainActor
final class DaemonLauncher {
    let paths: AppPaths
    let version: String
    private(set) var url: String?
    private var inFlight: Task<Result<String, Error>, Never>?
    private var upgradeTimer: Timer?

    init(paths: AppPaths, version: String) {
        self.paths = paths
        self.version = version
    }

    var pageURL: URL? {
        if let dev = paths.devServerURL { return dev }
        return url.flatMap(DaemonEnsure.pageURL(fromWebSocket:))
    }

    private var devFlags: [String] {
        guard paths.isDev else { return [] }
        // The dev bundle's version never moves between builds, so the script's
        // mtime is what tells a stale dev daemon from this one.
        let mtime = (try? FileManager.default.attributesOfItem(atPath: paths.daemonScript)[.modificationDate] as? Date)
            .map { String(Int($0.timeIntervalSince1970 * 1000)) }
        return ["--dev"] + (mtime.map { ["--app-build", $0] } ?? [])
    }

    /// The daemon's ws URL, starting it if need be. Concurrent callers (every
    /// window asks at launch) share one attempt.
    func ensure() async -> Result<String, Error> {
        if let inFlight { return await inFlight.value }
        let task = Task { await self.run(["ensure", "--app-version", version] + devFlags) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    func restart() async -> String? {
        try? await run(["restart"] + devFlags).get()
    }

    private func run(_ args: [String]) async -> Result<String, Error> {
        do {
            let out = try await Spawn.output(paths.node, [paths.daemonScript] + args, timeout: 60, group: .forDaemonCLI(paths))
            guard let result = DaemonEnsure.parse(stdout: out.stdout) else {
                throw BridgeError("The daemon launcher gave no answer (exit \(out.status)). \(out.stderrTail)")
            }
            guard let url = result.url else {
                throw BridgeError("The OmniFex daemon did not start. \(out.stderrTail)")
            }
            self.url = url
            armUpgradeCheck(result.outdated)
            return .success(url)
        } catch {
            return .failure(error)
        }
    }

    /// An older daemon that was mid-turn is kept for now; ask again in 30 s
    /// until it has been replaced. The CLI process that answered is gone, so
    /// the retry the TS launcher would schedule has to live here.
    private func armUpgradeCheck(_ outdated: Bool) {
        upgradeTimer?.invalidate()
        upgradeTimer = nil
        guard outdated else { return }
        upgradeTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            Task { @MainActor in _ = await self?.ensure() }
        }
    }

    /// Before an update swaps the bundle: the daemon outlives the app and
    /// would otherwise keep running from files the helper is about to delete.
    func stop(timeout: TimeInterval) async {
        _ = try? await Spawn.output(paths.node, [paths.daemonScript, "stop"] + (paths.isDev ? ["--dev"] : []), timeout: timeout, group: .forDaemonCLI(paths))
    }

    /// `applicationWillTerminate` cannot await.
    func stopSync(timeout: TimeInterval) {
        Spawn.runAndWait(paths.node, [paths.daemonScript, "stop", "--dev"], timeout: timeout)
    }

    /// Turns in flight on the daemon, for the install gate. nil = no answer.
    func remoteInFlight() async -> Int? {
        guard let url, let health = DaemonEnsure.healthURL(fromWebSocket: url) else { return nil }
        var req = URLRequest(url: health)
        req.timeoutInterval = 1.5
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return DaemonEnsure.inFlight(fromHealth: data)
    }
}
