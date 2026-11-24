import Foundation

/// The renderer decides whether a session is busy; this only aggregates. `sourceId` is bookkeeping, never payload.
public final class TabStatusStore {
    public typealias Summary = [String: Any]
    public struct Invalid: Error {}

    private var order: [String] = []
    private var summaries: [String: Summary] = [:]
    private var sources: [String: Int] = [:]
    private let broadcast: ([Summary]) -> Void

    public init(broadcast: @escaping ([Summary]) -> Void) {
        self.broadcast = broadcast
    }

    public func publishChecked(_ summary: Summary, source: Int?) throws {
        guard summary["tabId"] is String else { throw Invalid() }
        publish(summary, source: source)
    }

    public func publish(_ summary: Summary, source: Int?) {
        guard let tabId = summary["tabId"] as? String else { return }
        // Reattribute even when unchanged: an identical summary is exactly what a reloaded page sends first.
        sources[tabId] = source
        if let existing = summaries[tabId], NSDictionary(dictionary: existing).isEqual(to: summary) { return }
        if summaries[tabId] == nil { order.append(tabId) }
        summaries[tabId] = summary
        broadcast(list())
    }

    public func remove(_ tabId: String) {
        sources[tabId] = nil
        guard summaries.removeValue(forKey: tabId) != nil else { return }
        order.removeAll { $0 == tabId }
        broadcast(list())
    }

    /// Tabs never unmount on a reload or crash, so their summaries would live on as phantom "working" sessions.
    public func removeSource(_ source: Int) {
        let gone = sources.filter { $0.value == source }.map(\.key)
        guard !gone.isEmpty else { return }
        var removed = false
        for tabId in gone {
            sources[tabId] = nil
            if summaries.removeValue(forKey: tabId) != nil { removed = true }
        }
        order.removeAll { summaries[$0] == nil }
        if removed { broadcast(list()) }
    }

    public func list() -> [Summary] { order.compactMap { summaries[$0] } }

    public func busyTabIds() -> [String] {
        order.filter { (summaries[$0]?["busy"] as? Bool) == true }
    }

    public func workingTabIds() -> [String] {
        order.filter { (summaries[$0]?["promptStatus"] as? String) == "working" }
    }

    public func clearAll() {
        guard !summaries.isEmpty else { return }
        summaries.removeAll()
        sources.removeAll()
        order.removeAll()
        broadcast([])
    }
}
