/// Which process group the daemon's CLI (`ensure`, `restart`, `stop`) runs in.
///
/// A dev daemon is spawned by `ensure` with `detached: false` — "stay in my
/// parent's group" — and must land in the app's group, so Ctrl-C in the
/// `npm start` terminal reaches it (`electron/remote/dev-instance.ts`).
/// Foundation's `Process` makes every child the leader of a new group, which
/// left the dev daemon in `ensure`'s group, out of Ctrl-C's reach. So in dev
/// the CLI joins the caller's group. A packaged daemon is spawned detached and
/// meant to outlive the app; its CLI keeps `Process`'s own-group behaviour.
public enum LauncherProcessGroup: Equatable, Sendable {
    case callers
    case own

    public static func forDaemonCLI(_ paths: AppPaths) -> Self {
        paths.isDev ? .callers : .own
    }
}
