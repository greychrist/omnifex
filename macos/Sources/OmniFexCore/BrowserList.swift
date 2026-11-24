import Foundation

public enum BrowserList {
    public struct Entry: Equatable, Sendable {
        public let bundleId: String
        public let name: String
        public init(bundleId: String, name: String) {
            self.bundleId = bundleId
            self.name = name
        }
    }

    /// Parallels registers its Windows-VM app shims as https handlers; none is a browser on this Mac.
    static func isParallels(_ bundleId: String) -> Bool {
        bundleId.hasPrefix("com.parallels.")
    }

    public static func entries(_ raw: [Entry], excluding ownBundleId: String?) -> [Entry] {
        var seen = Set<String>()
        return raw
            .filter {
                !$0.bundleId.isEmpty && $0.bundleId != ownBundleId && !isParallels($0.bundleId)
                    && seen.insert($0.bundleId).inserted
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    public static func bridgeValue(_ entries: [Entry]) -> [[String: String]] {
        entries.map { ["bundleId": $0.bundleId, "name": $0.name] }
    }
}
