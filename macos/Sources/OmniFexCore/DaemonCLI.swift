import Foundation

public enum DaemonCLI {
    /// A dev build always passes `--dev`, so quitting it never stops the installed app's daemon.
    public static func stopArgs(_ paths: AppPaths) -> [String] {
        ["stop"] + (paths.isDev ? ["--dev"] : [])
    }

    /// The daemon `ensure` spawns must land in the app's process group.
    public static let group: LauncherProcessGroup = .callers

    /// Outwaits `stop`'s own 5s, so Quit & Reopen never adopts a daemon still closing.
    public static let quitStopTimeout: TimeInterval = 6
}
