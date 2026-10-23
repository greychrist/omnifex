import Foundation

/// Aggregator for renderer-published per-tab summaries.
///
/// Each chat tab computes its own busy/idle summary and publishes it; this
/// stores them and broadcasts the full list so the status popover subscribes
/// to one channel. The install gate and the quit prompt read it too — the
/// renderer is the canonical interpreter of "is this session busy?", the app
/// the canonical aggregator.
///
/// Summaries are kept as the JSON-shaped dictionaries the bridge delivers and
/// broadcast back unchanged; `sourceId` (the publishing web view) is the
/// store's own bookkeeping, never part of the payload.
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
        // Reattribution happens even when the payload is unchanged: an
        // identical summary is exactly what a reloaded page sends first.
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

    /// Drop every summary still attributed to `source`. Tabs remove themselves
    /// on unmount, which never happens on a reload or crash: the page is gone
    /// before an unmount effect can land, so its summaries used to live on as
    /// phantom "working" sessions and an install gate waiting on nothing.
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

    /// Work in flight OR waiting on the user — "let everything settle first".
    public func busyTabIds() -> [String] {
        order.filter { (summaries[$0]?["busy"] as? Bool) == true }
    }

    /// Agent actively working (`promptStatus === 'working'`), excluding tabs
    /// paused on a prompt. What "N sessions still running" counts.
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
