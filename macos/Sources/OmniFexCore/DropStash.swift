import Foundation

/// The paths of the files last dropped on a web view, for the page to take.
///
/// WebKit gives the page a dropped file's bytes and name but never its path,
/// so the page could only ever attach a copy. The web view puts the
/// pasteboard's file paths here before passing the drop on, and the page's
/// drop handler takes them over `drop:paths`, so Claude is pointed at the
/// file where it lives. Taking clears it; a stale stash (a drop the page
/// ignored) is never handed to a later drop.
public struct DropStash: Sendable {
    public let maxAge: TimeInterval
    private var paths: [String] = []
    private var at: TimeInterval = 0

    public init(maxAge: TimeInterval = 10) { self.maxAge = maxAge }

    public mutating func put(_ paths: [String], at: TimeInterval) {
        self.paths = paths
        self.at = at
    }

    public mutating func take(now: TimeInterval) -> [String] {
        defer { paths = [] }
        return now - at <= maxAge ? paths : []
    }
}
