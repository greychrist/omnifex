/// Which process group a child the app spawns runs in.
///
/// Foundation's `Process` makes every child the leader of a new group
/// (`.own`). The daemon's CLI must instead join the app's (`.callers`): the
/// daemon `ensure` starts inherits `ensure`'s group, and has to share the
/// app's. See `DaemonCLI.group`.
public enum LauncherProcessGroup: Equatable, Sendable {
    case callers
    case own
}
