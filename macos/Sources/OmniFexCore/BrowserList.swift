import Foundation

/// The browsers an account's sign-in links can be sent to, as the Settings
/// picker lists them. AppKit supplies the raw list (every app that opens
/// https URLs); this keeps the rules about it testable: one row per bundle,
/// ordered by name, and never OmniFex itself, which registers for https only
/// to receive its own links.
public enum BrowserList {
    public struct Entry: Equatable, Sendable {
        public let bundleId: String
        public let name: String
        public init(bundleId: String, name: String) {
            self.bundleId = bundleId
            self.name = name
        }
    }

    public static func entries(_ raw: [Entry], excluding ownBundleId: String?) -> [Entry] {
        var seen = Set<String>()
        return raw
            .filter { !$0.bundleId.isEmpty && $0.bundleId != ownBundleId && seen.insert($0.bundleId).inserted }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The shape `shell:listBrowsers` answers with.
    public static func bridgeValue(_ entries: [Entry]) -> [[String: String]] {
        entries.map { ["bundleId": $0.bundleId, "name": $0.name] }
    }
}
