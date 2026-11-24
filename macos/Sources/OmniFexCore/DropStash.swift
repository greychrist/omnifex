import Foundation

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
