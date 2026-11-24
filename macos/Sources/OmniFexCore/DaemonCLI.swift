import Foundation

/// How the app drives the daemon's own CLI (`omnifexd omnifex-server.js …`).
///
/// The daemon is the app's: `ensure` spawns it non-detached, inside the app's
/// process group, and the app stops it on quit.
public enum DaemonCLI {
    /// `stop` for this build's instance. A dev build always says `--dev`,
    /// which points the command at `~/.omnifex-dev`'s pid file — so quitting
    /// the dev app can never stop the installed app's daemon.
    public static func stopArgs(_ paths: AppPaths) -> [String] {
        ["stop"] + (paths.isDev ? ["--dev"] : [])
    }

    /// Every daemon CLI runs in the app's group, so the daemon `ensure`
    /// spawns lands there too.
    public static let group: LauncherProcessGroup = .callers

    /// How long quitting waits for `stop`. The command itself waits up to 5s
    /// for the daemon's pid to exit; outwaiting it means Quit & Reopen never
    /// meets — and adopts — a daemon that is still closing.
    public static let quitStopTimeout: TimeInterval = 6
}
